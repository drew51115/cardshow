// Show Mode v2, Phase 3: case scan (screens A–D). See CLAUDE.md "Show Mode v2".
// Loaded after js/show-mode.js, before app.html's main script.
//
// The old Bulk Scan sent the whole case in one request and waited for it,
// which timed out. Here each photo is its own job:
//   A  the seller takes photos (or picks several from the camera roll). Each
//      one is saved on the device (IndexedDB) the moment it's taken, then
//      queued.
//   B  the phone works through the queue one photo at a time: the existing
//      bulk-scan Edge Function (Claude, all cards in the photo) and CardSight
//      identify run in parallel. A failed or offline photo waits and retries
//      with backoff; a photo cut off by closing the app starts again on the
//      next open. The seller can keep selling meanwhile.
//   C  review: confident matches are pre-checked with prices from comps;
//      the rest are listed under "Needs a look".
//   D  fix one card: pick a candidate, type it in, or retake just that card.
// Committing adds the checked cards to inventory, live on the show, through
// the same outbox add_item op Show Mode already uses (idempotent on the
// item's client-generated id), each with its own crop as a saved capture.
//
// Batch, photo and item state lives on this device only (IndexedDB stores
// scanBatches and scanPhotos). There is no server-side job, so nothing new
// to deploy; the cards it creates are ordinary inventory rows.

const SC_MATCH_MIN = 0.85;      // top candidate confidence for "matched"
const SC_MATCH_GAP = 0.10;      // ...and its lead over the second candidate
const SC_PHOTO_EDGE = 2000;
const SC_PHOTO_QUALITY = 0.8;
const SC_MAX_ATTEMPTS = 5;      // server errors; waiting for signal doesn't count
const SC_BULK_TIMEOUT_MS = 60000;
const SC_CS_TIMEOUT_MS = 9500;
const SC_CARDS_PER_PHOTO = 9;
const SC_TYPICAL_PER_PHOTO = 6; // estimate for photos not processed yet
const SC_KEEP_DONE_DAYS = 7;

let _scProcessing = false;
let _scTimer = null;
let _scSummary = [];            // cached per-batch summaries for the home banner
let _scOn = null;               // { kind: 'capture'|'batch'|'review'|'fix', batchId, itemId }
let _scCaptureBatchId = null;
let _scTyping = false;          // D: "type it in" form open
const _scUrls = new Map();      // object URLs for photo thumbs and crops

function _scNow() { return Date.now(); }
function _scMine(r) { return r && r.seller === currentSeller; }

// ── Storage ─────────────────────────────────────────────────────────────────
async function _scBatches() { return (await smStore.all('scanBatches').catch(() => [])).filter(_scMine); }
async function _scPhotos(batchId) {
  const all = (await smStore.all('scanPhotos').catch(() => [])).filter(_scMine);
  return (batchId ? all.filter(p => p.batchId === batchId) : all).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

// Every photo write goes through here, one at a time, on the latest copy, so
// the processing loop, pricing and the seller's edits never overwrite each
// other.
let _scWriteChain = Promise.resolve();
function _scMutatePhoto(id, fn) {
  const run = _scWriteChain.then(async () => {
    const p = await smStore.get('scanPhotos', id);
    if (!p) return null;
    const out = fn(p);
    if (out === false) return p;
    await smStore.put('scanPhotos', p);
    return p;
  });
  _scWriteChain = run.catch(() => {});
  return run;
}
function _scMutateItem(photoId, itemId, fn) {
  return _scMutatePhoto(photoId, p => {
    const it = (p.items || []).find(i => i.id === itemId);
    if (!it) return false;
    return fn(it, p);
  });
}

function _scUrl(key, blob) {
  if (_scUrls.has(key)) return _scUrls.get(key);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  _scUrls.set(key, u);
  return u;
}
function _scThumbFor(item, photo) {
  return (item && item.crop && _scUrl('crop:' + item.id, item.crop)) || (photo && _scUrl('photo:' + photo.id, photo.thumb)) || null;
}

// ── Pure helpers (exposed for tests) ────────────────────────────────────────
const SC_CLAUDE_CONF = { high: 0.9, medium: 0.7, low: 0.4 };
const SC_CS_CONF = { high: 0.9, medium: 0.75, low: 0.55 };

// A bulk-scan card (lowercase strings) → the identification fields Show Mode uses.
function scFromBulk(card) {
  if (!card || typeof card !== 'object') return null;
  const tc = typeof _titleCase === 'function' ? _titleCase : (s => s);
  const grade = typeof _numericGrade === 'function' ? _numericGrade(card.grade) : String(card.grade || '');
  const grader = _smNormGrader(card.grader);
  return {
    source: 'claude',
    player: tc(String(card.player || '').trim()),
    year: card.year ? String(card.year).slice(0, 9) : '',
    cardSet: tc(String(card.set || '').trim()),
    number: String(card.cardNumber || '').trim(),
    parallel: /^base$/i.test(String(card.parallel || '').trim()) ? '' : tc(String(card.parallel || '').trim()),
    grader: grader && grade ? grader : (grader || ''),
    grade: grader ? grade : '',
    cert: grader ? String(card.certNumber || '').replace(/\s+/g, '') : '',
    confidence: ['high', 'medium', 'low'].includes(card.confidence) ? card.confidence : 'low',
    notes: String(card.notes || '').trim(),
    box: scValidBox(card.box),
  };
}

function scValidBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const v = b.map(Number);
  if (v.some(n => !isFinite(n) || n < 0 || n > 1)) return null;
  const [x, y, w, h] = v;
  if (w < 0.03 || h < 0.03 || x + w > 1.02 || y + h > 1.02) return null;
  return v;
}

function _scFieldsOf(x) {
  return {
    player: x.player || '', year: x.year || '', cardSet: x.cardSet || '', number: x.number || '',
    parallel: x.parallel || '', grader: x.grader || '', grade: x.grade || '', cert: x.cert || '',
  };
}
function _scYearsAgree(a, b) { return !a || !b || String(a).slice(0, 4) === String(b).slice(0, 4); }

// Confidence rule: matched when the top candidate is at least SC_MATCH_MIN
// and leads the next one by at least SC_MATCH_GAP; otherwise needs a look.
// Nothing readable at all → failed.
function scClassify(candidates) {
  const top = candidates && candidates[0];
  if (!top || !(top.fields.player || top.fields.cardSet)) return 'failed';
  const second = candidates[1] ? candidates[1].confidence : 0;
  const gap = Math.round((top.confidence - second) * 1000) / 1000;
  return top.confidence >= SC_MATCH_MIN && gap >= SC_MATCH_GAP ? 'matched' : 'needs_review';
}

// Claude's cards (each with a box) paired with CardSight's detections by
// player name + year. Agreement → 0.95 with catalog set/number/parallel.
// CardSight detections nobody paired become low "Wrong card?" options on the
// unpaired cards. If Claude found nothing, CardSight's detections stand alone.
function scBuildItems(claudeCards, detections) {
  const cl = (claudeCards || []).map(scFromBulk).filter(Boolean);
  const cs = (detections || []).map(raw => ({ n: _smFromCardSight(raw), raw }))
    .filter(d => d.n && (d.n.player || d.n.cardSet));
  const used = new Set();
  const out = cl.map(c => {
    const j = c.player ? cs.findIndex((d, i) => !used.has(i) && _smNamesAgree(c.player, d.n.player) && _scYearsAgree(c.year, d.n.year)) : -1;
    let candidates;
    if (j >= 0) {
      used.add(j);
      const merged = smMergeIdentification(c, cs[j].n, cs[j].raw.suggestions || []);
      candidates = [{ fields: merged.fields, confidence: 0.95, catalogCardId: merged.catalogCardId || null, source: 'both' }]
        .concat(merged.candidates.map(x => ({ fields: _scFieldsOf(x), confidence: 0.6, catalogCardId: x.catalogCardId || null, source: 'cardsight' })));
    } else {
      candidates = [{ fields: _scFieldsOf(c), confidence: SC_CLAUDE_CONF[c.confidence], catalogCardId: null, source: 'claude' }];
    }
    return { box: c.box, notes: c.notes, candidates, paired: j >= 0 };
  });
  const leftovers = cs.filter((_, i) => !used.has(i)).map(d => d.n);
  if (!cl.length) {
    leftovers.forEach(d => out.push({
      box: null, notes: '', paired: false,
      candidates: [{ fields: _scFieldsOf(d), confidence: SC_CS_CONF[d.confidence] || 0.55, catalogCardId: d.catalogCardId || null, source: 'cardsight' }],
    }));
  } else if (leftovers.length) {
    out.filter(it => !it.paired).forEach(it => {
      leftovers.forEach(d => it.candidates.push({
        fields: Object.assign(_scFieldsOf(d), { grader: it.candidates[0].fields.grader || d.grader, grade: it.candidates[0].fields.grade || d.grade, cert: it.candidates[0].fields.cert || d.cert }),
        confidence: 0.5, catalogCardId: d.catalogCardId || null, source: 'cardsight',
      }));
    });
  }
  return out.map(it => {
    const state = scClassify(it.candidates);
    return {
      id: _smUuid(), box: it.box, candidates: it.candidates, selected: 0, state,
      note: state === 'failed' ? (it.notes || 'Couldn\'t read this one') : it.notes,
      price: '', market: null, include: true, existingId: null, inventoryId: null, captureId: null, crop: null,
    };
  });
}

// Estimate of cards across a batch: real counts for processed photos, a
// typical count for the rest.
function scEstimate(photos) {
  const done = photos.filter(p => p.status === 'done');
  const per = done.length ? Math.max(1, Math.round(done.reduce((s, p) => s + p.items.length, 0) / done.length)) : SC_TYPICAL_PER_PHOTO;
  return done.reduce((s, p) => s + p.items.length, 0) + (photos.length - done.length) * per;
}

function scBackoffMs(attempt) { return Math.min(5000 * Math.pow(2, Math.max(0, attempt - 1)), 60000); }

// ── Images ──────────────────────────────────────────────────────────────────
async function _scCompress(source, maxEdge) {
  const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
  return _smCanvasBlob(_smDrawScaled(source, 0, 0, w, h, maxEdge), SC_PHOTO_QUALITY);
}
async function _scBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (_) { return createImageBitmap(blob); }
}
// Card crop from a normalized [x, y, w, h] box, padded a little since the
// model's boxes are approximate.
async function _scCropBox(bmp, box) {
  const pad = 0.06;
  const W = bmp.width, H = bmp.height;
  let x = (box[0] - box[2] * pad) * W, y = (box[1] - box[3] * pad) * H;
  let w = box[2] * (1 + 2 * pad) * W, h = box[3] * (1 + 2 * pad) * H;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(W - x, w); h = Math.min(H - y, h);
  if (w < 20 || h < 20) return null;
  return _smCanvasBlob(_smDrawScaled(bmp, x, y, w, h, 1200), 0.85);
}

// ── Batches and photos ──────────────────────────────────────────────────────
async function _scEnsureBatch() {
  if (_scCaptureBatchId) {
    const b = await smStore.get('scanBatches', _scCaptureBatchId).catch(() => null);
    if (b && _scMine(b) && b.status !== 'completed') return b;
  }
  const b = { id: _smUuid(), seller: currentSeller, showId: _smShowId, createdAt: _scNow(), status: 'open' };
  await smStore.put('scanBatches', b);
  _scCaptureBatchId = b.id;
  try { sessionStorage.setItem('scCaptureBatch', b.id); } catch (_) {}
  _smLogEvent('scan_batch_started', {});
  return b;
}

async function _scAddPhoto(blob, thumb) {
  const batch = await _scEnsureBatch();
  const existing = await _scPhotos(batch.id);
  const photo = {
    id: _smUuid(), batchId: batch.id, seller: currentSeller, order: existing.length + 1,
    blob, thumb, bytes: blob.size, status: 'queued', attempts: 0, nextTryAt: 0, error: null,
    items: [], createdAt: _scNow(),
  };
  await smStore.put('scanPhotos', photo);
  scKick();
  return photo;
}

// ── Processing queue ────────────────────────────────────────────────────────
function scKick() {
  clearTimeout(_scTimer);
  _scTimer = null;
  _scProcessLoop();
}

async function _scProcessLoop() {
  if (_scProcessing || !currentSeller || typeof db === 'undefined') return;
  _scProcessing = true;
  try {
    for (;;) {
      const pending = (await _scPhotos()).filter(p => p.status === 'queued' || p.status === 'waiting');
      if (!pending.length) break;
      if (!navigator.onLine) {
        for (const p of pending) if (p.status !== 'waiting') await _scMutatePhoto(p.id, x => { x.status = 'waiting'; x.error = 'offline'; });
        await _scAfterChange();
        break;   // the 'online' event restarts the loop
      }
      const now = _scNow();
      const next = pending.filter(p => p.nextTryAt <= now).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) {
        const soonest = Math.min(...pending.map(p => p.nextTryAt));
        _scTimer = setTimeout(_scProcessLoop, Math.max(500, soonest - now));
        break;
      }
      await _scProcessPhoto(next);
    }
  } catch (e) {
    console.warn('[case-scan] queue failed', e);
  } finally {
    _scProcessing = false;
  }
}

async function _scProcessPhoto(photo) {
  await _scMutatePhoto(photo.id, p => { p.status = 'working'; p.error = null; });
  await _scAfterChange();
  const started = performance.now();
  const attempt = photo.attempts + 1;
  let outcome;
  try { outcome = await _scIdentifyPhoto(photo); }
  catch (e) { outcome = { kind: navigator.onLine ? 'retry' : 'offline', error: e && e.message }; }

  if (outcome.kind === 'ok') {
    const items = scBuildItems(outcome.cards, outcome.detections);
    const bmp = items.some(i => i.box) ? await _scBitmap(photo.blob).catch(() => null) : null;
    for (const it of items) {
      if (bmp && it.box) it.crop = await _scCropBox(bmp, it.box).catch(() => null);
      _scMarkExisting(it);
    }
    if (bmp && bmp.close) bmp.close();
    await _scMutatePhoto(photo.id, p => {
      p.status = 'done'; p.items = items; p.error = null; p.attempts = attempt; p.offlineTries = 0; p.doneAt = _scNow();
      p.emptyResult = !items.length;
    });
    _smLogEvent('scan_photo_uploaded', { attempt, bytes: photo.bytes, latencyMs: Math.round(performance.now() - started), cards: items.length });
    await _scAfterChange();
    _scNotifyIfBatchReady(photo.batchId);
    _scPriceItems(photo.id);
    return;
  }

  const offline = outcome.kind === 'offline' || !navigator.onLine;
  _smLogEvent('scan_photo_failed', { attempt, error: outcome.error || outcome.kind, bytes: photo.bytes });
  await _scMutatePhoto(photo.id, p => {
    if (offline) {
      p.offlineTries = (p.offlineTries || 0) + 1;
      p.status = 'waiting'; p.error = 'offline'; p.nextTryAt = _scNow() + scBackoffMs(p.offlineTries);
    } else if (outcome.kind === 'fatal' || attempt >= SC_MAX_ATTEMPTS) {
      p.status = 'failed'; p.attempts = attempt; p.error = outcome.error || 'Couldn\'t read this photo';
    } else {
      p.status = 'waiting'; p.attempts = attempt; p.error = outcome.error || 'retrying';
      p.nextTryAt = _scNow() + scBackoffMs(attempt);
    }
  });
  await _scAfterChange();
}

// One photo → { kind: 'ok', cards, detections } | { kind: 'retry'|'offline'|'fatal', error }.
async function _scIdentifyPhoto(photo) {
  const { data } = await db.auth.getSession();
  const token = data && data.session && data.session.access_token;
  if (!token) return { kind: 'retry', error: 'Signed out — sign in again to finish this scan' };

  const bulk = (async () => {
    const form = new FormData();
    form.append('image', photo.blob, 'case.jpg');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SC_BULK_TIMEOUT_MS);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/bulk-scan`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: ctl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      return { status: res.status, body };
    } finally { clearTimeout(t); }
  })();
  const cardsight = (async () => {
    const image_base64 = await _smBlobToBase64(photo.blob);
    return _smFetchJson('/.netlify/functions/cardsight-identify', { image_base64, media_type: 'image/jpeg', all: true }, SC_CS_TIMEOUT_MS);
  })();
  const [b, c] = await Promise.allSettled([bulk, cardsight]);
  const detections = (c.status === 'fulfilled' && c.value && c.value.success && Array.isArray(c.value.detections)) ? c.value.detections : [];

  if (b.status === 'rejected') {
    if (!navigator.onLine) return { kind: 'offline' };
    const aborted = b.reason && b.reason.name === 'AbortError';
    if (aborted) return { kind: 'retry', error: 'Took too long — trying again' };
    if (detections.length) return { kind: 'ok', cards: [], detections };
    return { kind: 'offline' };   // dropped connection: wait for signal, don't use up an attempt
  }
  const { status, body } = b.value;
  if (status === 200 && body && Array.isArray(body.cards)) return { kind: 'ok', cards: body.cards, detections };
  const msg = (body && (body.message || body.error)) || `Error ${status}`;
  if (status === 413 || status === 415) return { kind: 'fatal', error: msg };
  if (status === 401) return { kind: 'retry', error: 'Session expired — retrying' };
  return { kind: 'retry', error: msg };
}

// A slab whose cert matches a card already in the case links to that card
// instead of adding a duplicate.
function _scMarkExisting(it) {
  const f = it.candidates[it.selected] && it.candidates[it.selected].fields;
  it.existingId = null;
  if (!f || !f.cert) return;
  const cert = String(f.cert).replace(/\s+/g, '');
  const hit = _smAvailable().find(r => r['Cert #'] && String(r['Cert #']).replace(/\s+/g, '') === cert);
  if (hit) { it.existingId = hit._dbId; it.price = String(Math.round(Number(hit.Price) || 0) || ''); }
}

// Market prices for one photo's cards, one at a time; fills an empty price.
async function _scPriceItems(photoId) {
  const p = await smStore.get('scanPhotos', photoId).catch(() => null);
  if (!p) return;
  for (const it of p.items) {
    if (it.state === 'failed' || it.market != null || it.existingId) continue;
    if (!navigator.onLine) return;
    const f = it.candidates[it.selected].fields;
    if (!f.player) continue;
    const v = await _smMarketFor(_smFieldsToCard(f)).catch(() => null);
    await _scMutateItem(photoId, it.id, x => {
      x.market = v || 0;
      if (v && !x.price) x.price = String(Math.round(v));
    });
    _scRefreshItemPrice(it.id);
  }
}
function _scRefreshItemPrice(itemId) {
  if (!_scOn || _scOn.kind !== 'review') return;
  _scLoadBatch(_scOn.batchId).then(({ photos }) => {
    const it = photos.flatMap(p => p.items).find(i => i.id === itemId);
    const input = document.querySelector(`[data-sc-price="${itemId}"]`);
    if (it && input && document.activeElement !== input && !input.value) input.value = it.price || '';
    const meta = document.querySelector(`[data-sc-market="${itemId}"]`);
    if (it && meta) meta.textContent = it.market ? 'Market ' + _smMoney(it.market) : 'Market —';
  });
}

async function _scNotifyIfBatchReady(batchId) {
  const photos = await _scPhotos(batchId);
  if (photos.some(p => p.status !== 'done' && p.status !== 'failed')) return;
  if (_smScreen === 'add' || !_smShowId) return;   // already on a case-scan screen (including still taking photos)
  const n = photos.flatMap(p => p.items).filter(i => i.state !== 'added' && i.state !== 'skipped').length;
  if (!n) return;
  _scActionToast(`Case scan ready · ${n} card${n === 1 ? '' : 's'} to review`, 'Review', () => smGo('/add/batches/' + batchId + '/review'));
}

function _scActionToast(text, label, fn) {
  if (typeof smHideToast === 'function') smHideToast();
  const t = document.createElement('div');
  t.id = 'smUndoToast';
  t.className = 'sm-toast';
  t.innerHTML = `<span>${smEsc(text)}</span><button class="sm-toast-btn">${smEsc(label)}</button>`;
  t.querySelector('button').onclick = () => { t.remove(); fn(); };
  document.getElementById('showModeRoot').appendChild(t);
  setTimeout(() => { if (t.isConnected) t.remove(); }, 8000);
}

window.addEventListener('online', () => {
  if (!currentSeller) return;
  _scPhotos().then(list => Promise.all(list.filter(p => p.status === 'waiting' && p.error === 'offline')
    .map(p => _scMutatePhoto(p.id, x => { x.nextTryAt = 0; })))).then(scKick);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentSeller) scKick(); });

// Called once the seller's shows are loaded (smAfterShowsLoaded): a photo
// left "working" by a closed app goes back in the queue, old finished batches
// are cleared out, and the queue starts.
async function scResume() {
  if (!smIsEnabled() || currentRole !== 'seller') return;
  try { _scCaptureBatchId = sessionStorage.getItem('scCaptureBatch') || null; } catch (_) {}
  const photos = await _scPhotos();
  for (const p of photos) if (p.status === 'working') await _scMutatePhoto(p.id, x => { x.status = 'queued'; x.nextTryAt = 0; });
  const cutoff = _scNow() - SC_KEEP_DONE_DAYS * 86400000;
  for (const b of await _scBatches()) {
    if (b.status === 'completed' && (b.completedAt || b.createdAt) < cutoff) {
      for (const p of photos.filter(x => x.batchId === b.id)) await smStore.del('scanPhotos', p.id).catch(() => {});
      await smStore.del('scanBatches', b.id).catch(() => {});
    }
  }
  await scUpdateSummary();
  scKick();
}

// ── Summary (home banner) ───────────────────────────────────────────────────
async function scUpdateSummary() {
  const batches = (await _scBatches()).filter(b => b.status !== 'completed');
  const all = await _scPhotos();
  _scSummary = batches.map(b => {
    const photos = all.filter(p => p.batchId === b.id);
    const items = photos.flatMap(p => p.items || []);
    return {
      id: b.id, createdAt: b.createdAt, photos: photos.length,
      working: photos.filter(p => p.status !== 'done' && p.status !== 'failed').length,
      found: items.length,
      toReview: items.filter(i => i.state === 'matched' || i.state === 'needs_review' || i.state === 'failed').length,
    };
  }).filter(s => s.photos > 0 && (s.working || s.toReview)).sort((a, b) => b.createdAt - a.createdAt);
  return _scSummary;
}

function scHomeBannerHTML() {
  return _scSummary.slice(0, 2).map(s => {
    const status = s.working
      ? `${s.found} found so far · ${s.working} photo${s.working === 1 ? '' : 's'} left`
      : `${s.toReview} card${s.toReview === 1 ? '' : 's'} ready to review`;
    return `<button class="sm-sec-btn sc-home-banner" onclick="smGo('/add/batches/${smEsc(s.id)}${s.working ? '' : '/review'}')">
      ${_smIcon('image')}<span><span style="display:block">Case scan</span><span class="sm-row-meta" style="display:block">${smEsc(status)}</span></span>${_smIcon('chev', 'sm-chev')}
    </button>`;
  }).join('');
}

// After any photo change: refresh the home banner and whatever case-scan
// screen is open.
async function _scAfterChange() {
  await scUpdateSummary();
  if (!_smShowId) return;
  if (_smScreen === 'home') smRenderHome();
  else if (_smScreen === 'add' && _scOn) {
    if (_scOn.kind === 'batch') scRenderBatch(_scOn.batchId, true);
    else if (_scOn.kind === 'capture') _scRenderTray();
    else if (_scOn.kind === 'review') scRenderReview(_scOn.batchId, true);
  }
}

// ── Routing ─────────────────────────────────────────────────────────────────
// #/sm/<show>/add/scan[/<batchId>]           A
// #/sm/<show>/add/batches/<id>               B
// #/sm/<show>/add/batches/<id>/review        C
// #/sm/<show>/add/batches/<id>/items/<item>  D
function scRoute(parts) {
  if (parts[1] === 'batches' && parts[2]) {
    if (parts[3] === 'review') return scRenderReview(parts[2]);
    if (parts[3] === 'items' && parts[4]) return scRenderFix(parts[2], parts[4]);
    return scRenderBatch(parts[2]);
  }
  return scRenderCapture(parts[2]);
}
function scIsCameraRoute(parts) { return parts[0] === 'add' && (!parts[1] || parts[1] === 'scan'); }

async function _scLoadBatch(batchId) {
  const batch = await smStore.get('scanBatches', batchId).catch(() => null);
  const photos = batch && _scMine(batch) ? await _scPhotos(batchId) : [];
  return { batch: batch && _scMine(batch) ? batch : null, photos };
}

// ── A. Photograph the case ──────────────────────────────────────────────────
async function scRenderCapture(batchId) {
  _scOn = { kind: 'capture', batchId: null };
  if (batchId) {
    const b = await smStore.get('scanBatches', batchId).catch(() => null);
    if (b && _scMine(b) && b.status !== 'completed') _scCaptureBatchId = b.id;
  } else {
    // A fresh visit starts a new batch unless this one has no photos yet.
    const cur = _scCaptureBatchId ? await _scPhotos(_scCaptureBatchId) : [];
    if (cur.length) _scCaptureBatchId = null;
  }
  _scOn.batchId = _scCaptureBatchId;
  _smView().innerHTML = `
    <div class="sm-dark-header">
      <button class="sm-dark-btn" onclick="scCloseCapture()" aria-label="Close">${_smIcon('close')}</button>
      <div class="sm-sell-title" style="margin:0">Scan your case</div>
      <button class="sm-dark-btn" id="smFlashBtn" onclick="smToggleTorch()" aria-label="Flash" aria-pressed="false" style="visibility:hidden">${_smIcon('flash')}</button>
    </div>
    <div class="sm-camera sc-camera" id="smCamera">
      <video id="smVideo" playsinline muted autoplay></video>
      <div class="sc-guide" id="scGuide" aria-hidden="true"></div>
      <div class="sm-camera-msg" id="smCameraMsg"></div>
    </div>
    <div class="sm-camera-caption">Lay up to ${SC_CARDS_PER_PHOTO} cards or slabs flat. Hold steady, then tap the button.</div>
    <div class="sc-tray" id="scTray" aria-live="polite"></div>
    <div class="sm-shutter-row">
      <button class="sm-dark-btn sm-dark-btn--text" onclick="document.getElementById('scFileInput').click()">${_smIcon('image')}<span>Photos</span></button>
      <button class="sm-shutter sc-shutter" id="scShutter" onclick="scCapture()" aria-label="Take photo"></button>
      <button class="sc-done-btn" id="scDoneBtn" onclick="scCaptureDone()" disabled>Done</button>
    </div>
    <button class="sm-link sc-other-ways" onclick="openQuickActions('add')">Other ways to add cards</button>
    <input type="file" id="scFileInput" accept="image/*" multiple style="display:none" onchange="scHandleFiles(this)">`;
  smStartCamera();
  _scRenderTray();
}

async function _scRenderTray() {
  const tray = document.getElementById('scTray');
  if (!tray) return;
  const photos = _scCaptureBatchId ? await _scPhotos(_scCaptureBatchId) : [];
  const done = document.getElementById('scDoneBtn');
  if (done) { done.disabled = !photos.length; done.textContent = photos.length ? `Done · ${photos.length}` : 'Done'; }
  if (!photos.length) { tray.innerHTML = '<div class="sc-tray-empty">Your photos show up here. Take as many as you need.</div>'; return; }
  tray.innerHTML = `<div class="sc-tray-row">${photos.map(p => `
      <div class="sc-tray-thumb"><img src="${smEsc(_scUrl('photo:' + p.id, p.thumb) || '')}" alt=""><span>${p.order}</span></div>`).join('')}</div>
    <div class="sc-tray-meta">${photos.length} photo${photos.length === 1 ? '' : 's'} · ~${scEstimate(photos)} cards</div>`;
}

async function scCapture() {
  const video = document.getElementById('smVideo');
  const guide = document.getElementById('scGuide');
  if (!video || !video.videoWidth) { document.getElementById('scFileInput')?.click(); return; }
  const btn = document.getElementById('scShutter');
  if (btn) btn.disabled = true;
  try {
    const r = _smGuideRectInVideo(video, guide);
    const blob = await _smCanvasBlob(_smDrawScaled(video, r.x, r.y, r.w, r.h, SC_PHOTO_EDGE), SC_PHOTO_QUALITY);
    const thumb = await _smCanvasBlob(_smDrawScaled(video, r.x, r.y, r.w, r.h, 320), 0.7);
    if (navigator.vibrate) navigator.vibrate(15);
    await _scAddPhoto(blob, thumb);
    _scRenderTray();
  } catch (e) {
    console.warn('[case-scan] capture failed', e);
    showToast('Couldn\'t take that photo — try again', 'var(--danger)');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function scHandleFiles(input) {
  const files = [...(input.files || [])];
  input.value = '';
  for (const file of files) {
    try {
      const bmp = await _scBitmap(file);
      const blob = await _scCompress(bmp, SC_PHOTO_EDGE);
      const thumb = await _scCompress(bmp, 320);
      if (bmp.close) bmp.close();
      await _scAddPhoto(blob, thumb);
    } catch (e) {
      console.warn('[case-scan] photo read failed', e);
      showToast('Couldn\'t read one of those photos', 'var(--danger)');
    }
  }
  _scRenderTray();
}

async function scCaptureDone() {
  if (!_scCaptureBatchId) return;
  const id = _scCaptureBatchId;
  _scCaptureBatchId = null;
  try { sessionStorage.removeItem('scCaptureBatch'); } catch (_) {}
  smGo('/add/batches/' + id);
}
async function scCloseCapture() {
  const photos = _scCaptureBatchId ? await _scPhotos(_scCaptureBatchId) : [];
  if (photos.length) return scCaptureDone();
  smGoHome();
}

// ── B. Uploads in the background ────────────────────────────────────────────
const SC_STATUS = {
  queued:  { label: 'In line',  cls: 'sm-badge--warn' },
  working: { label: 'Working',  cls: 'sm-badge--warn' },
  waiting: { label: 'Waiting',  cls: 'sm-badge--warn' },
  done:    { label: 'Done',     cls: 'sm-badge--ok' },
  failed:  { label: 'Failed',   cls: 'sc-badge--bad' },
};

async function scRenderBatch(batchId, quiet) {
  const { batch, photos } = await _scLoadBatch(batchId);
  if (!batch) { smGo('', true); return; }
  _scOn = { kind: 'batch', batchId };
  const items = photos.flatMap(p => p.items);
  const ready = items.filter(i => i.state === 'matched' || i.state === 'needs_review' || i.state === 'failed').length;
  const estimate = Math.max(scEstimate(photos), items.length);
  const finished = photos.filter(p => p.status === 'done' || p.status === 'failed').length;
  const pct = photos.length ? Math.round(finished / photos.length * 100) : 0;
  const allDone = finished === photos.length;
  const rows = photos.map(p => {
    const st = SC_STATUS[p.status] || SC_STATUS.queued;
    let detail;
    if (p.status === 'done') detail = p.items.length ? `${p.items.length} card${p.items.length === 1 ? '' : 's'} matched` : 'No cards found';
    else if (p.status === 'working') detail = 'Matching…';
    else if (p.status === 'waiting') detail = p.error === 'offline' ? 'Waiting for signal' : `Trying again soon${p.error && p.error !== 'retrying' ? ' · ' + p.error : ''}`;
    else if (p.status === 'failed') detail = p.error || 'Couldn\'t read this photo';
    else detail = 'Waiting its turn';
    const label = p.status === 'waiting' && p.error === 'offline' ? 'Waiting for signal' : st.label;
    const retry = (p.status === 'waiting' || p.status === 'failed')
      ? `<button class="sm-row-btn sm-row-btn--ghost" onclick="scRetryPhoto('${smEsc(p.id)}')">Retry now</button>` : '';
    return `<div class="sm-row">
      <img class="sc-photo-thumb" src="${smEsc(_scUrl('photo:' + p.id, p.thumb) || '')}" alt="">
      <div class="sm-row-body">
        <div class="sm-row-title">Photo ${p.order} <span class="sm-badge ${st.cls}">${smEsc(label)}</span></div>
        <div class="sm-row-meta">${smEsc(detail)}</div>
      </div>${retry}
    </div>`;
  }).join('');
  const html = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="smGoHome()" aria-label="Back to show">${_smIcon('back')}</button>
      <div class="sm-title">Case scan</div>
      <span style="width:44px"></span>
    </div>
    <div class="sc-summary">
      <div class="sc-summary-num">${items.length} <span>of ~${estimate} cards found</span></div>
      <div class="sc-progress" role="progressbar" aria-label="Photos processed" aria-valuemin="0" aria-valuemax="${photos.length}" aria-valuenow="${finished}"><i style="width:${pct}%"></i></div>
      <div class="sc-summary-text">${allDone ? 'All photos are done.' : 'You can close this and keep selling. We\'ll let you know when it\'s ready to review.'}</div>
    </div>
    <div class="sm-list">${rows}</div>
    <button class="sm-primary" onclick="smGo('/add/batches/${smEsc(batchId)}/review')" ${ready ? '' : 'disabled'}>Review ${ready} ready now</button>
    <div class="sc-two">
      <button class="sm-sec-btn" onclick="smGoHome()">Keep selling</button>
      <button class="sm-sec-btn" onclick="smGo('/add/scan/${smEsc(batchId)}')">${_smIcon('plus')}Add photos</button>
    </div>`;
  if (quiet && _smView().dataset.scHtml === html) return;
  _smView().innerHTML = html;
  _smView().dataset.scHtml = html;
}

async function scRetryPhoto(photoId) {
  await _scMutatePhoto(photoId, p => {
    if (p.status === 'failed') p.attempts = 0;
    p.status = 'queued'; p.nextTryAt = 0; p.error = null;
  });
  await _scAfterChange();
  scKick();
}

// ── C. Review matches ───────────────────────────────────────────────────────
function _scItemName(f) { return f.player || f.cardSet || 'Unknown card'; }
function _scItemMeta(f) {
  return [f.year, f.cardSet, f.number ? '#' + f.number : '', f.grader ? `${f.grader} ${f.grade}`.trim() : 'Raw'].filter(Boolean).join(' · ');
}

async function scRenderReview(batchId, quiet) {
  const { batch, photos } = await _scLoadBatch(batchId);
  if (!batch) { smGo('', true); return; }
  _scOn = { kind: 'review', batchId };
  if (quiet && document.activeElement && document.activeElement.matches('[data-sc-price]')) return;   // don't clobber typing
  const all = photos.flatMap(p => p.items.map(it => ({ it, p })));
  const needs = all.filter(x => x.it.state === 'needs_review' || x.it.state === 'failed');
  const matched = all.filter(x => x.it.state === 'matched');
  const added = all.filter(x => x.it.state === 'added' || x.it.state === 'committing').length;
  const skipped = all.filter(x => x.it.state === 'skipped').length;
  const working = photos.filter(p => p.status !== 'done' && p.status !== 'failed').length;
  const checked = matched.filter(x => x.it.include).length;

  const needsHTML = needs.map(({ it, p }) => {
    const f = it.candidates[it.selected] ? it.candidates[it.selected].fields : {};
    const failed = it.state === 'failed';
    const why = failed ? it.note : (it.candidates.length > 1 ? `${it.candidates.length} possible matches` : 'Not sure about this one');
    return `<div class="sm-row sc-needs">
      ${_scImg(it, p)}
      <div class="sm-row-body">
        <div class="sm-row-title">${smEsc(failed ? 'Couldn\'t read this one' : _scItemName(f))}</div>
        <div class="sm-row-meta">${smEsc(failed ? why : why + ' · ' + _scItemMeta(f))}</div>
      </div>
      <button class="sm-row-btn" onclick="smGo('/add/batches/${smEsc(batchId)}/items/${smEsc(it.id)}')">${failed ? 'Fix' : 'Pick'}</button>
    </div>`;
  }).join('');

  const matchedHTML = matched.map(({ it, p }) => {
    const f = it.candidates[it.selected].fields;
    const src = it.existingId ? 'Already in your case' : (it.crop ? 'Your photo' : 'Case photo');
    const market = it.existingId ? '' : `<span data-sc-market="${smEsc(it.id)}">${it.market == null ? 'Market …' : (it.market ? 'Market ' + _smMoney(it.market) : 'Market —')}</span>`;
    return `<div class="sm-row sc-match ${it.include ? '' : 'sc-off'}">
      <label class="sc-check"><input type="checkbox" ${it.include ? 'checked' : ''} onchange="scToggleInclude('${smEsc(p.id)}','${smEsc(it.id)}',this.checked)" aria-label="Add ${smEsc(_scItemName(f))}"></label>
      <button class="sc-img-btn" onclick="smGo('/add/batches/${smEsc(batchId)}/items/${smEsc(it.id)}')" aria-label="Change ${smEsc(_scItemName(f))}">${_scImg(it, p)}</button>
      <div class="sm-row-body">
        <div class="sm-row-title">${smEsc(_scItemName(f))}</div>
        <div class="sm-row-meta">${smEsc([f.grader ? `${f.grader} ${f.grade}`.trim() : 'Raw', src].join(' · '))}</div>
        <div class="sm-row-meta">${market}</div>
      </div>
      ${it.existingId ? '' : `<label class="sc-price"><span class="sm-sr-only">Price for ${smEsc(_scItemName(f))}</span>$<input type="text" inputmode="numeric" data-sc-price="${smEsc(it.id)}"
        value="${smEsc(it.price || '')}" placeholder="0" oninput="scSetPrice('${smEsc(p.id)}','${smEsc(it.id)}',this.value)"></label>`}
    </div>`;
  }).join('');

  const notes = [];
  if (working) notes.push(`${working} photo${working === 1 ? '' : 's'} still matching`);
  if (added) notes.push(`${added} already added`);
  if (skipped) notes.push(`${skipped} removed`);
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="smGo('/add/batches/${smEsc(batchId)}')" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Review ${needs.length + matched.length} card${needs.length + matched.length === 1 ? '' : 's'}</div>
      <span style="width:44px"></span>
    </div>
    <div class="sm-row-meta" style="margin:-6px 0 12px">Prices filled from recent comps${notes.length ? ' · ' + smEsc(notes.join(' · ')) : ''}</div>
    ${needs.length ? `<div class="sm-section-label sc-needs-label">Needs a look</div><div class="sm-list" style="margin-bottom:16px">${needsHTML}</div>` : ''}
    ${matched.length ? `<div class="sm-section-label">Matched</div><div class="sm-list">${matchedHTML}</div>`
      : (needs.length ? '' : '<div class="sm-empty">Nothing left to review in this scan.</div>')}
    <button class="sm-primary" id="scCommitBtn" onclick="scCommit('${smEsc(batchId)}')" ${checked ? '' : 'disabled'}>Add ${checked} to case · live now</button>
    ${needs.length && checked ? '<div class="sm-helper">Cards under "Needs a look" stay here until you fix them.</div>' : ''}`;
}

function _scImg(it, p) {
  const u = _scThumbFor(it, p);
  return u ? `<img class="sm-thumb" src="${smEsc(u)}" alt="">` : '<div class="sm-thumb" aria-hidden="true"></div>';
}

async function scToggleInclude(photoId, itemId, on) {
  await _scMutateItem(photoId, itemId, it => { it.include = !!on; });
  const { photos } = await _scLoadBatch(_scOn.batchId);
  const checked = photos.flatMap(p => p.items).filter(i => i.state === 'matched' && i.include).length;
  const btn = document.getElementById('scCommitBtn');
  if (btn) { btn.disabled = !checked; btn.textContent = `Add ${checked} to case · live now`; }
  document.querySelector(`[data-sc-price="${itemId}"]`)?.closest('.sc-match')?.classList.toggle('sc-off', !on);
}
function scSetPrice(photoId, itemId, v) {
  const clean = String(v).replace(/[^0-9.]/g, '');
  _scMutateItem(photoId, itemId, it => { it.price = clean; });
}

// Commit: every checked match becomes an inventory card, live on the show.
// Each item gets its inventory id before anything is queued, so tapping again
// (or reopening after a crash) re-sends the same idempotent add_item.
async function scCommit(batchId) {
  const btn = document.getElementById('scCommitBtn');
  if (btn) btn.disabled = true;
  const { batch, photos } = await _scLoadBatch(batchId);
  if (!batch) return;
  const showId = batch.showId && shows[batch.showId] ? batch.showId : _smShowId;
  let added = 0, linked = 0;
  const stats = { matched: 0, needsReview: 0, fixed: 0, skipped: 0 };
  for (const p of photos) {
    for (const it0 of p.items) {
      if (it0.state === 'needs_review' || it0.state === 'failed') stats.needsReview++;
      if (it0.state === 'skipped') stats.skipped++;
      if (it0.fixed) stats.fixed++;
      if (!((it0.state === 'matched' && it0.include) || it0.state === 'committing')) continue;
      stats.matched++;
      const it = await _scMutateItem(p.id, it0.id, x => {
        if (!x.inventoryId) x.inventoryId = x.existingId || _smUuid();
        x.state = 'committing';
      }).then(ph => ph && ph.items.find(i => i.id === it0.id));
      if (!it) continue;
      const cand = it.candidates[it.selected];
      const f = cand.fields;
      let captureId = it.captureId;
      if (!captureId && it.crop) {
        const cap = await smSaveCapture({ crop: it.crop, original: null, entryPoint: 'case_scan' });
        captureId = cap.id;
        const ident = { fields: f, confidence: cand.confidence >= SC_MATCH_MIN ? 'high' : 'medium', catalogCardId: cand.catalogCardId || null, candidates: [], sources: {}, batchId };
        await smUpdateCapture(captureId, { identification: ident, attachedTo: it.inventoryId }, {
          identification: ident, catalog_card_id: cand.catalogCardId || null, cert_number: f.cert || null,
          grader: f.grader || null, grade: f.grade || null, confidence: ident.confidence,
        });
        await _scMutateItem(p.id, it.id, x => { x.captureId = captureId; });
      }
      if (it.existingId) {
        if (captureId) {
          _smCaptureIndex.set(it.existingId, captureId);
          await smEnqueue({ type: 'attach_capture', captureId, inventoryId: it.existingId });
        }
        linked++;
      } else {
        let card = inventory.find(c => c._dbId === it.inventoryId);
        if (!card) {
          card = _smCardFromNewItem(Object.assign({}, f, { asking: it.price || '0' }));
          card._dbId = it.inventoryId;
          card._smPending = true;
          if (captureId) card._captureId = captureId;
          inventory.push(card);
        }
        if (captureId) _smCaptureIndex.set(card._dbId, captureId);
        await smEnqueue({ type: 'add_item', inventoryId: card._dbId, cardSnapshot: _smSnapshot(card), captureId: captureId || null, showId, source: 'case_scan' });
        added++;
      }
      _smLogEvent('capture_attached', { entryPoint: 'case_scan', attachType: 'case_scan', existing: !!it.existingId });
      await _scMutateItem(p.id, it.id, x => { x.state = 'added'; });
    }
  }
  _smLogEvent('scan_review_completed', Object.assign(stats, { added: added + linked }));
  await _scMaybeComplete(batchId);
  _smAfterInventoryChange();
  await scUpdateSummary();
  const parts = [];
  if (added) parts.push(`${added} card${added === 1 ? '' : 's'} added — live on your show`);
  if (linked) parts.push(`${linked} already in your case`);
  showToast('✓ ' + (parts.join(' · ') || 'Nothing to add'));
  smGo('/inventory');
}

async function _scMaybeComplete(batchId) {
  const { batch, photos } = await _scLoadBatch(batchId);
  if (!batch) return;
  const open = photos.some(p => p.status !== 'done' && p.status !== 'failed') ||
    photos.some(p => p.items.some(i => i.state === 'matched' || i.state === 'needs_review' || i.state === 'failed' || i.state === 'committing'));
  if (open) return;
  batch.status = 'completed';
  batch.completedAt = _scNow();
  await smStore.put('scanBatches', batch);
  // The full photos aren't needed any more; the crops stay as captures.
  for (const p of photos) await _scMutatePhoto(p.id, x => { x.blob = null; });
}

// ── D. Fix one card ─────────────────────────────────────────────────────────
async function _scFindItem(batchId, itemId) {
  const { batch, photos } = await _scLoadBatch(batchId);
  if (!batch) return {};
  for (const p of photos) {
    const it = p.items.find(i => i.id === itemId);
    if (it) return { batch, photo: p, item: it };
  }
  return { batch };
}

async function scRenderFix(batchId, itemId) {
  const { photo, item } = await _scFindItem(batchId, itemId);
  if (!item) { smGo('/add/batches/' + batchId + '/review', true); return; }
  _scOn = { kind: 'fix', batchId, itemId };
  _scTyping = false;
  _scRenderFixBody(photo, item);
}

function _scRenderFixBody(photo, item) {
  const { batchId } = _scOn;
  const img = _scThumbFor(item, photo);
  const tiles = item.candidates.map((c, i) => {
    const f = c.fields;
    return `<button class="sc-tile" aria-pressed="${i === item.selected}" onclick="scSelectCandidate(${i})">
      <span class="sc-tile-name">${smEsc(_scItemName(f))}${f.parallel ? ' · ' + smEsc(f.parallel) : ''}</span>
      <span class="sm-row-meta">${smEsc([f.year, f.cardSet, f.number ? '#' + f.number : ''].filter(Boolean).join(' · '))}</span>
      <span class="sm-row-meta">${smEsc(f.grader ? `${f.grader} ${f.grade}`.trim() : 'Raw')}</span>
    </button>`;
  }).join('');
  const f0 = (item.candidates[item.selected] || item.candidates[0] || { fields: {} }).fields;
  const failed = item.state === 'failed';
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="smGo('/add/batches/${smEsc(batchId)}/review')" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Which one is it?</div>
      <span style="width:44px"></span>
    </div>
    <div class="sc-fix-top">
      ${img ? `<img class="sc-fix-img" src="${smEsc(img)}" alt="Your photo of this card">` : '<div class="sc-fix-img" aria-hidden="true"></div>'}
      <div class="sm-row-meta">${failed ? smEsc(item.note || 'We couldn\'t read this card.') + ' Retake it, or type it in.' : 'Pick the right card, or type it in if neither matches.'}
        ${item.crop ? '' : '<br><br>This is the whole photo. Find the card in it.'}</div>
    </div>
    ${failed ? '' : `<div class="sc-tiles">${tiles}</div>`}
    <details class="sm-details" id="scTypeBox" ${failed ? 'open' : ''}>
      <summary>Neither? Type it in</summary>
      <div class="sm-form-row">${_smField('Player', 'scF_player', f0.player)}${_smField('Year', 'scF_year', f0.year, 'numeric')}</div>
      <div class="sm-form-row">${_smField('Set', 'scF_cardSet', f0.cardSet)}${_smField('Card #', 'scF_number', f0.number)}</div>
      <div class="sm-form-row">${_smField('Parallel', 'scF_parallel', f0.parallel)}</div>
      <div class="sm-form-row">${_smField('Grader', 'scF_grader', f0.grader)}${_smField('Grade', 'scF_grade', f0.grade, 'decimal')}${_smField('Cert #', 'scF_cert', f0.cert, 'numeric')}</div>
    </details>
    <button class="sm-primary" onclick="scUseMatch()">Use this match</button>
    <div class="sc-two">
      <button class="sm-sec-btn" onclick="document.getElementById('scRetakeInput').click()">${_smIcon('scan')}Retake this card</button>
      <button class="sm-sec-btn" onclick="smGo('/add/batches/${smEsc(batchId)}/review')">Skip for now</button>
    </div>
    <div class="sm-links"><button class="sm-link" onclick="scRemoveItem()">Not a card — remove it</button></div>
    <div class="sm-sr-only" aria-live="polite" id="scFixLive"></div>
    <input type="file" id="scRetakeInput" accept="image/*" capture="environment" style="display:none" onchange="scRetake(this)">`;
}

async function scSelectCandidate(i) {
  const { batchId, itemId } = _scOn;
  const { photo, item } = await _scFindItem(batchId, itemId);
  if (!item) return;
  await _scMutateItem(photo.id, itemId, it => { it.selected = i; });
  document.querySelectorAll('.sc-tile').forEach((b, j) => b.setAttribute('aria-pressed', j === i));
  const f = item.candidates[i].fields;
  ['player', 'year', 'cardSet', 'number', 'parallel', 'grader', 'grade', 'cert'].forEach(k => {
    const el = document.getElementById('scF_' + k);
    if (el) el.value = f[k] || '';
  });
}

function _scTypedFields() {
  const v = k => (document.getElementById('scF_' + k)?.value || '').trim();
  return { player: v('player'), year: v('year'), cardSet: v('cardSet'), number: v('number'), parallel: v('parallel'),
    grader: _smNormGrader(v('grader')), grade: v('grade'), cert: v('cert') };
}

async function scUseMatch() {
  const { batchId, itemId } = _scOn;
  const { photo, item } = await _scFindItem(batchId, itemId);
  if (!item) return;
  const typed = _scTypedFields();
  if (!typed.player && !typed.cardSet) { showToast('Add at least the player or set', 'gold'); document.getElementById('scTypeBox').open = true; return; }
  const sel = item.candidates[item.selected] || { fields: {} };
  const edited = ['player', 'year', 'cardSet', 'number', 'parallel', 'grader', 'grade', 'cert'].some(k => (sel.fields[k] || '') !== typed[k]);
  await _scMutateItem(photo.id, itemId, it => {
    if (edited || !it.candidates.length) {
      it.candidates.unshift({ fields: typed, confidence: 1, catalogCardId: null, source: 'seller' });
      it.selected = 0;
    }
    it.state = 'matched'; it.include = true; it.fixed = true; it.market = null; it.note = '';
    _scMarkExisting(it);
  });
  _scPriceItems(photo.id);
  smGo('/add/batches/' + batchId + '/review');
}

async function scRemoveItem() {
  const { batchId, itemId } = _scOn;
  const { photo } = await _scFindItem(batchId, itemId);
  if (!photo) return;
  await _scMutateItem(photo.id, itemId, it => { it.state = 'skipped'; });
  await _scMaybeComplete(batchId);
  await scUpdateSummary();
  smGo('/add/batches/' + batchId + '/review');
}

// Retake: one new photo of just this card, identified with the single-card
// path (Claude + CardSight), replacing this item's candidates and crop.
async function scRetake(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const { batchId, itemId } = _scOn;
  const live = document.getElementById('scFixLive');
  if (live) live.textContent = 'Identifying the card';
  showToast('Identifying…');
  try {
    const { crop } = await _smImagesFromFile(file);
    const ident = navigator.onLine ? await smIdentify(crop) : null;
    const { photo } = await _scFindItem(batchId, itemId);
    if (!photo) return;
    await _scMutateItem(photo.id, itemId, it => {
      it.crop = crop;
      _scUrls.delete('crop:' + it.id);
      if (ident && ident.fields) {
        const top = { high: 0.95, medium: 0.75, low: 0.5 }[ident.confidence] || 0.5;
        it.candidates = [{ fields: ident.fields, confidence: top, catalogCardId: ident.catalogCardId || null, source: 'retake' }]
          .concat(ident.candidates.map(c => ({ fields: _scFieldsOf(c), confidence: 0.6, catalogCardId: c.catalogCardId || null, source: 'cardsight' })));
        it.selected = 0;
        it.state = scClassify(it.candidates);
        it.note = it.state === 'failed' ? 'Still couldn\'t read it — type it in' : '';
        it.market = null;
        _scMarkExisting(it);
      }
    });
    if (!ident || !ident.fields) showToast(navigator.onLine ? 'Couldn\'t read that one either — type it in' : 'No signal — type it in for now', 'gold');
    const fresh = await _scFindItem(batchId, itemId);
    if (fresh.item && fresh.item.state === 'matched') {
      showToast('✓ Matched');
      _scPriceItems(photo.id);
      smGo('/add/batches/' + batchId + '/review');
      return;
    }
    if (fresh.item) _scRenderFixBody(fresh.photo, fresh.item);
    if (live) live.textContent = ident && ident.fields ? 'Pick the right card' : 'Could not identify the card';
  } catch (e) {
    console.warn('[case-scan] retake failed', e);
    showToast('Couldn\'t read that photo', 'var(--danger)');
  }
}

// Test hooks (pure functions only).
window.__scTest = { scFromBulk, scValidBox, scClassify, scBuildItems, scEstimate, scBackoffMs, SC_MATCH_MIN, SC_MATCH_GAP };
