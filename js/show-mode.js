// ══════ SHOW MODE v2 (flag: show_mode_v2) ══════
// Mobile-first seller screens for a live show. See CLAUDE.md "Show Mode v2".
// Loaded by app.html before its main script; uses app.html globals at call
// time (db, inventory, shows, currentSeller, cardToDbRow, showToast, ...).
//
// Off by default. Test switch: ?show_mode=1 turns it on for this browser,
// ?show_mode=0 turns it back off (remembered in localStorage, like the GTCR
// consent switch). With the flag off nothing here runs and the classic seller
// UI is unchanged.
//
// Phase 2 adds: scan/search to sell, confirm, Sold + undo, the Show Mode
// inventory list, saved card captures (photos + identification, private
// bucket), Log a manual sale in-flow, Recent scans, and an IndexedDB outbox so
// sales and captures made with no signal sync exactly once later.

const SHOW_MODE_V2_ENABLED = false;
const SHOW_MODE_TEST_KEY = 'showModeTest';
function _smTestOverride() {
  try {
    const url = new URL(location.href);
    const p = url.searchParams.get('show_mode');
    if (p === '1') localStorage.setItem(SHOW_MODE_TEST_KEY, '1');
    else if (p === '0') localStorage.removeItem(SHOW_MODE_TEST_KEY);
    if (p !== null) {
      url.searchParams.delete('show_mode');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return localStorage.getItem(SHOW_MODE_TEST_KEY) === '1';
  } catch (_) {
    return false;
  }
}
const SHOW_MODE_ON = SHOW_MODE_V2_ENABLED || _smTestOverride();
function smIsEnabled() { return SHOW_MODE_ON; }

// var, not let: app.html's updateStats() reads it and can run before this
// file's lexical bindings would otherwise be safe to touch.
var _smShowId = null;          // show Show Mode is open for, or null when closed
let _smScreen = 'home';
let _smUid = null;             // seller's auth uid (storage paths), from the cached session
const SM_HASH_RE = /^#\/sm\/([^/?#]+)(\/[^?#]*)?/;
const SM_UNDO_TOAST_MS = 5000;
const SM_UNDO_WINDOW_MS = 10 * 60 * 1000;   // server enforces the same 10 minutes
const SM_MATCH_THRESHOLD = 70;
const SM_INVENTORY_PAGE = 100;
const SM_PAYMENTS = ['Cash', 'Venmo', 'Card'];

const SM_ICON = {
  scan:    '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8.5" y="7.5" width="7" height="9" rx="1"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  pen:     '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  share:   '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12M7 8l5-5 5 5"/>',
  chev:    '<path d="M9 6l6 6-6 6"/>',
  back:    '<path d="M15 6l-6 6 6 6"/>',
  close:   '<path d="M6 6l12 12M18 6L6 18"/>',
  flash:   '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  check:   '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search:  '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  image:   '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  user:    '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
};
function _smIcon(name, cls) {
  return `<svg class="sm-icon ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${SM_ICON[name]}</svg>`;
}

// _escHtml() in app.html turns 0 into ''. Prices and grades can be 0.
function smEsc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _smMoney(n) { return '$' + Math.round(Number(n) || 0).toLocaleString(); }
function _smUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
function _smDevice() { return window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop'; }

// ── Analytics ───────────────────────────────────────────────────────────────
// Show Mode events go to show_events (no third-party client). Fire-and-forget;
// never blocks the UI. Events raised with no signal are dropped.
function _smLogEvent(type, data) {
  if (typeof db === 'undefined' || !_smShowId || !navigator.onLine) return;
  db.from('show_events').insert({
    show_id: _smShowId,
    event_type: 'sm_' + type,
    event_data: Object.assign({ seller: currentSeller, device: _smDevice() }, data || {}),
  }).then(({ error }) => { if (error) console.warn('[show-mode] event log failed', error.message); });
}

// ════════════════════════════════════════════════════════════════════════════
// Local store (IndexedDB): captures (photos + identification) and the outbox.
// ════════════════════════════════════════════════════════════════════════════
let _smDbPromise = null;
function _smIdb() {
  if (_smDbPromise) return _smDbPromise;
  _smDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no_indexeddb')); return; }
    // v2 (Phase 3): scanBatches + scanPhotos for case scans (js/show-mode-scan.js).
    const req = indexedDB.open('cardshow-showmode', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('captures')) d.createObjectStore('captures', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!d.objectStoreNames.contains('scanBatches')) d.createObjectStore('scanBatches', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('scanPhotos')) d.createObjectStore('scanPhotos', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); _smDbPromise = null; };   // let another tab upgrade
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  _smDbPromise.catch(() => { _smDbPromise = null; });
  return _smDbPromise;
}
async function _smIdbDo(store, mode, fn) {
  const d = await _smIdb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    let result;
    const r = fn(tx.objectStore(store));
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const smStore = {
  put: (store, value) => _smIdbDo(store, 'readwrite', s => s.put(value)),
  get: (store, key) => _smIdbDo(store, 'readonly', s => s.get(key)),
  del: (store, key) => _smIdbDo(store, 'readwrite', s => s.delete(key)),
  all: (store) => _smIdbDo(store, 'readonly', s => s.getAll()),
};

// ════════════════════════════════════════════════════════════════════════════
// Outbox: every server write Show Mode makes goes through here, in order, so a
// sale made with no signal replays exactly once (record_sale is idempotent on
// client_sale_id). Ops: capture_row, capture_update, sale, void, add_item,
// attach_capture.
// Photo uploads run separately (_smUploadCaptures) since they're large.
// ════════════════════════════════════════════════════════════════════════════
let _smDraining = false;
let _smDrainTimer = null;
let _smDrainDelay = 5000;
let _smRpcMissing = false;        // record_sale/void_sale not installed → classic writes
let _smCapturesMissing = false;   // card_captures table not installed → photos stay on device

async function smEnqueue(op) {
  op.seller = currentSeller;
  op.queuedAt = Date.now();
  try { await smStore.put('outbox', op); }
  catch (e) { console.warn('[show-mode] outbox unavailable, running op directly', e); return _smRunOp(op); }
  smDrain();
}

function _smIsNetworkError(res) {
  if (!navigator.onLine) return true;
  if (!res) return true;
  if (res.status === 0) return true;
  const m = (res.error && res.error.message) || '';
  return /failed to fetch|networkerror|load failed|network request failed|fetch/i.test(m) && !res.error.code;
}
function _smIsMissingFunction(res) {
  const e = res && res.error;
  return !!e && (e.code === 'PGRST202' || res.status === 404 || /could not find the function/i.test(e.message || ''));
}
function _smIsMissingTable(res) {
  const e = res && res.error;
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(e.message || ''));
}

async function smDrain() {
  if (_smDraining || typeof db === 'undefined' || !currentSeller) return;
  _smDraining = true;
  clearTimeout(_smDrainTimer);
  let blocked = false;
  try {
    const ops = (await smStore.all('outbox')).sort((a, b) => a.seq - b.seq);
    for (const op of ops) {
      if (op.seller !== currentSeller) continue;   // another seller's queue on this device
      if (!navigator.onLine) { blocked = true; break; }
      const outcome = await _smRunOp(op);
      if (outcome === 'retry') { blocked = true; break; }
      await smStore.del('outbox', op.seq);
    }
  } catch (e) {
    console.warn('[show-mode] drain failed', e);
    blocked = true;
  } finally {
    _smDraining = false;
  }
  if (blocked) {
    _smDrainTimer = setTimeout(smDrain, _smDrainDelay);
    _smDrainDelay = Math.min(_smDrainDelay * 2, 60000);
  } else {
    _smDrainDelay = 5000;
    _smUploadCaptures();
  }
  smRefresh();
}
window.addEventListener('online', () => { _smDrainDelay = 5000; smDrain(); });

// Returns 'done' (remove from outbox) or 'retry' (network; keep and stop).
async function _smRunOp(op) {
  try {
    switch (op.type) {
      case 'capture_row':    return await _smOpCaptureRow(op);
      case 'capture_update': return await _smOpCaptureUpdate(op);
      case 'sale':           return await _smOpSale(op);
      case 'void':           return await _smOpVoid(op);
      case 'add_item':       return await _smOpAddItem(op);
      case 'attach_capture': return await _smOpAttachCapture(op);
      default:               return 'done';
    }
  } catch (e) {
    console.warn('[show-mode] op failed', op.type, e);
    return navigator.onLine ? 'done' : 'retry';
  }
}

async function _smOpCaptureRow(op) {
  if (_smCapturesMissing) return 'done';
  const cap = await smStore.get('captures', op.captureId).catch(() => null);
  if (!cap) return 'done';
  const res = await db.from('card_captures')
    .upsert(_smCaptureRow(cap), { onConflict: 'id', ignoreDuplicates: true });
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    if (_smIsMissingTable(res)) { _smCapturesMissing = true; console.info('[show-mode] card_captures not installed — photos stay on this device'); return 'done'; }
    console.warn('[show-mode] capture row failed', res.error.message);
    return 'done';
  }
  cap.rowSynced = true;
  await smStore.put('captures', cap);
  return 'done';
}

async function _smOpCaptureUpdate(op) {
  if (_smCapturesMissing) return 'done';
  const res = await db.from('card_captures').update(op.fields).eq('id', op.captureId);
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    if (_smIsMissingTable(res)) { _smCapturesMissing = true; return 'done'; }
    console.warn('[show-mode] capture update failed', res.error.message);
  }
  return 'done';
}

function _smFindCardBySale(clientSaleId) {
  return inventory.find(c => c._clientSaleId === clientSaleId) || null;
}

async function _smOpSale(op) {
  const p = op.payload;
  const card = _smFindCardBySale(op.clientSaleId) || op.cardSnapshot;
  if (_smRpcMissing) return _smLegacySale(op, card);

  const res = await db.rpc('record_sale', {
    p_client_sale_id: op.clientSaleId,
    p_inventory_id:   p.inventoryId || null,
    p_new_item:       p.newItem || null,
    p_show_id:        p.showId || null,
    p_price:          p.price,
    p_payment_method: p.payment,
    p_buyer_handle:   p.buyerHandle || null,
    p_sold_date:      p.soldDate,
    p_sold_time:      p.soldTime,
    p_capture_id:     _smCapturesMissing ? null : (p.captureId || null),
    p_source:         p.source || 'show_mode',
  });
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    if (_smIsMissingFunction(res)) {
      _smRpcMissing = true;
      console.info('[show-mode] record_sale not installed — using the classic sale path');
      return _smLegacySale(op, card);
    }
    console.warn('[show-mode] record_sale rejected', res.error.message);
    if (card && card !== op.cardSnapshot) _smRevertCard(card, p.inventoryId ? 'restore' : 'drop');
    showToast(`Sale not recorded — ${res.error.message}`, 'var(--danger)');
    return 'done';
  }
  const out = res.data || {};
  if (out.error === 'already_sold') {
    if (card && card !== op.cardSnapshot) {
      card._smPending = false;
      card._clientSaleId = null;
      card._saleConflict = true;
      _smRefetchCard(card);
    }
    showToast('That card was already marked sold — this sale wasn\'t recorded', 'var(--danger)');
    return 'done';
  }
  if (card) {
    if (card !== op.cardSnapshot) {
      card._smPending = false;
      if (out.inventory_id) card._dbId = out.inventory_id;
      if (out.sold_at) card._saleAt = Date.parse(out.sold_at) || card._saleAt;
      if (p.showId) { if (!(card._shows instanceof Set)) card._shows = new Set(); card._shows.add(p.showId); }
    }
    // Ledger row, exactly once: show_floor_transactions has a unique index on
    // client_sale_id, so a retried insert is rejected instead of duplicated.
    if (out.status === 'completed' && p.showId && shows[p.showId]) {
      const ledgerCard = Object.assign({}, card, {
        _dbId: out.inventory_id || card._dbId, _clientSaleId: op.clientSaleId,
        _ledgerSource: p.source === 'manual_sale' ? 'manual' : 'platform',
      });
      await _insertShowTransaction(ledgerCard, p.showId);
    }
  }
  // record_sale() writes the sale server-side, bypassing updateCardInDB(), so
  // schedule the GTCR reconcile here: it removes a sold card's registration.
  if (out.status === 'completed' && typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();
  return 'done';
}

// Classic path for a project that hasn't run the Show Mode migration yet:
// the same writes sdConfirm()/confirmManualSale() make. Not atomic, and an
// offline replay can't be deduplicated — the migration fixes both.
async function _smLegacySale(op, card) {
  const p = op.payload;
  if (!card) return 'done';
  if (p.newItem) {
    const id = await insertCardToDB(card);
    if (!id) return navigator.onLine ? 'done' : 'retry';
    card._dbId = id;
  }
  await updateCardInDB(card);
  if (p.showId && card._dbId && !(card._shows instanceof Set && card._shows.has(p.showId))) {
    _autoPublishCardToShow(card, card._dbId, p.showId);
  }
  if (p.showId) {
    if (p.source === 'manual_sale') recordManualSaleTransaction(card, p.showId);
    else recordShowTransaction(card, p.showId);
  }
  card._smPending = false;
  return 'done';
}

async function _smOpVoid(op) {
  const card = _smFindCardBySale(op.clientSaleId) || inventory.find(c => c._dbId === op.inventoryId);
  if (_smRpcMissing) {
    if (card) await updateCardInDB(card);   // card already restored to Available locally
    return 'done';
  }
  const res = await db.rpc('void_sale', { p_client_sale_id: op.clientSaleId });
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    if (_smIsMissingFunction(res)) {
      _smRpcMissing = true;
      if (card) await updateCardInDB(card);
      return 'done';
    }
    console.warn('[show-mode] void_sale rejected', res.error.message);
    showToast(`Undo failed — ${res.error.message}`, 'var(--danger)');
    if (card) _smRefetchCard(card);
    return 'done';
  }
  if (res.data && res.data.error === 'undo_window_expired') {
    showToast('Too late to undo — it\'s been more than 10 minutes', 'var(--danger)');
    if (card) _smRefetchCard(card);
  } else if (typeof gtcrScheduleReconcile === 'function') {
    gtcrScheduleReconcile(); // the card is back in the case: re-register it if the seller opted in
  }
  return 'done';
}

async function _smOpAddItem(op) {
  const card = inventory.find(c => c._dbId === op.inventoryId) || op.cardSnapshot;
  const uid = await _smGetUid();
  if (!uid) return 'retry';
  let row = Object.assign({}, cardToDbRow(card), { id: op.inventoryId, seller_id: uid, source: op.source || 'show_mode' });
  let res = await db.from('inventory').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (res.error && _isMissingScanColumnError(res.error)) {
    ['fingerprint', 'detected_confidence', 'sport', 'serial_number', 'print_run_size', 'features',
     'category', 'subcategory', 'source'].forEach(k => delete row[k]);
    res = await db.from('inventory').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  }
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    console.warn('[show-mode] add item failed', res.error.message);
    showToast(`Couldn't add the card — ${res.error.message}`, 'var(--danger)');
    return 'done';
  }
  if (card && card !== op.cardSnapshot) card._smPending = false;
  if (op.showId && card) _autoPublishCardToShow(card, op.inventoryId, op.showId);
  if (card && typeof gtcrCheckCard === 'function') gtcrCheckCard(card, op.inventoryId, 'insert');
  // Added by upsert, not insertCardToDB(), so schedule the GTCR reconcile here.
  if (typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();
  if (op.captureId && !_smCapturesMissing) {
    await db.from('card_captures').update({ inventory_id: op.inventoryId, status: 'attached' }).eq('id', op.captureId);
    await db.from('inventory').update({ primary_capture_id: op.captureId, image_source: 'seller' })
      .eq('id', op.inventoryId).is('primary_capture_id', null);
  }
  return 'done';
}

// A capture for a card that's already in inventory (a case-scan slab whose
// cert matched): link it, and make it the card's image if it has none.
async function _smOpAttachCapture(op) {
  if (_smCapturesMissing) return 'done';
  let res = await db.from('card_captures').update({ inventory_id: op.inventoryId, status: 'attached' }).eq('id', op.captureId);
  if (res.error && _smIsNetworkError(res)) return 'retry';
  res = await db.from('inventory').update({ primary_capture_id: op.captureId, image_source: 'seller' })
    .eq('id', op.inventoryId).is('primary_capture_id', null);
  if (res.error && _smIsNetworkError(res)) return 'retry';
  return 'done';
}

// After the seller's inventory (re)loads from the DB, put back whatever the
// outbox still holds, so a sale made with no signal doesn't reappear as
// Available on a reload before it syncs.
async function smApplyPendingOps() {
  if (!smIsEnabled()) return;
  let ops = [];
  try { ops = (await smStore.all('outbox')).filter(o => o.seller === currentSeller).sort((a, b) => a.seq - b.seq); }
  catch (_) { return; }
  ops.forEach(op => {
    if (op.type === 'sale') {
      let card = op.payload.inventoryId
        ? inventory.find(c => c._dbId === op.payload.inventoryId)
        : inventory.find(c => c._dbId === op.cardSnapshot._dbId);
      if (!card && !op.payload.inventoryId) { card = Object.assign({}, op.cardSnapshot); inventory.push(card); }
      if (!card) return;
      Object.assign(card, {
        Status: 'Sold', SoldPrice: op.payload.price, PaymentMethod: op.payload.payment,
        SoldTime: op.payload.soldTime, SoldDate: op.payload.soldDate,
        _clientSaleId: op.clientSaleId, _saleAt: op.cardSnapshot._saleAt, _smPending: true,
      });
      if (op.payload.captureId) card._captureId = op.payload.captureId;
    } else if (op.type === 'add_item') {
      if (!inventory.some(c => c._dbId === op.inventoryId)) inventory.push(Object.assign({}, op.cardSnapshot, { _smPending: true }));
    } else if (op.type === 'void') {
      const card = inventory.find(c => c._dbId === op.inventoryId);
      if (card) { _smClearSold(card); card._clientSaleId = null; }
    }
  });
  if (ops.length) { _smAfterInventoryChange(); smDrain(); }
}

function _smRevertCard(card, how) {
  card._smPending = false;
  card._clientSaleId = null;
  if (how === 'drop') {
    const i = inventory.indexOf(card);
    if (i >= 0) inventory.splice(i, 1);
  } else {
    _smClearSold(card);
  }
  _smAfterInventoryChange();
}

function _smClearSold(card) {
  card.Status = 'Available';
  card.SoldPrice = null;
  card.PaymentMethod = null;
  card.SoldTime = null;
  card.SoldDate = null;
  card.SaleNotes = null;
}

async function _smRefetchCard(card) {
  if (!card._dbId) return;
  const { data } = await db.from('inventory').select('*').eq('id', card._dbId).maybeSingle();
  if (data) {
    const fresh = dbRowToCard(data);
    ['Status', 'Price'].forEach(k => { card[k] = fresh[k]; });
    card.SoldPrice = data.sold_price ?? null;
    card.PaymentMethod = data.payment_method ?? null;
    card.SoldTime = data.sold_time ?? null;
    card.SoldDate = data.sold_date ?? null;
  }
  _smAfterInventoryChange();
}

function _smAfterInventoryChange() {
  if (typeof renderSellerTable === 'function') renderSellerTable(getSellerInventory());
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateReport === 'function') updateReport();
  if (typeof syncBuyerView === 'function') syncBuyerView();
}

async function _smGetUid() {
  if (_smUid) return _smUid;
  try {
    const { data } = await db.auth.getSession();   // local; works offline
    _smUid = data?.session?.user?.id || null;
  } catch (_) {}
  return _smUid;
}

// ════════════════════════════════════════════════════════════════════════════
// Captures: every scan from Sell a card / Log a manual sale is saved on the
// device first (IndexedDB), then its row and photos go to Supabase. Photos
// are re-encoded through a canvas, which drops EXIF (including GPS).
// ════════════════════════════════════════════════════════════════════════════
const _smThumbUrls = new Map();   // captureId → object URL

function _smCaptureKeys(uid, id) {
  return {
    original_key: `${uid}/${id}/original.jpg`,
    crop_key:     `${uid}/${id}/crop.jpg`,
    back_key:     `${uid}/${id}/back.jpg`,
  };
}

function _smCaptureRow(cap) {
  const ident = cap.identification || {};
  const f = ident.fields || {};
  const keys = _smCaptureKeys(cap.uid, cap.id);
  return {
    id: cap.id,
    show_id: cap.showId || null,
    entry_point: cap.entryPoint,
    original_key: cap.hasOriginal ? keys.original_key : null,
    crop_key: keys.crop_key,
    back_key: cap.back ? keys.back_key : null,
    catalog_card_id: ident.catalogCardId || null,
    cert_number: f.cert || null,
    grader: f.grader || null,
    grade: f.grade != null && f.grade !== '' ? String(f.grade) : null,
    confidence: ident.confidence || null,
    identification: cap.identification || null,
  };
}

async function smSaveCapture({ crop, original, entryPoint }) {
  const uid = await _smGetUid();
  const cap = {
    id: _smUuid(),
    uid,
    seller: currentSeller,
    showId: _smShowId,
    entryPoint,
    createdAt: Date.now(),
    crop,
    original: original || null,
    hasOriginal: !!original,
    back: null,
    identification: null,
    attachedTo: null,
    deleted: false,
    rowSynced: false,
    uploaded: { crop: false, original: !original, back: true },
  };
  let savedLocally = true;
  try { await smStore.put('captures', cap); }
  catch (e) { savedLocally = false; console.warn('[show-mode] could not save capture locally', e); }
  if (savedLocally) await smEnqueue({ type: 'capture_row', captureId: cap.id });
  _smLogEvent('capture_saved', { entryPoint, savedOffline: !navigator.onLine, savedLocally });
  return cap;
}

async function smUpdateCapture(id, changes, serverFields) {
  const cap = await smStore.get('captures', id).catch(() => null);
  if (cap) { Object.assign(cap, changes); await smStore.put('captures', cap); }
  if (serverFields) await smEnqueue({ type: 'capture_update', captureId: id, fields: serverFields });
  return cap;
}

function smThumbUrl(captureId, blob) {
  if (!captureId) return null;
  if (_smThumbUrls.has(captureId)) return _smThumbUrls.get(captureId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _smThumbUrls.set(captureId, url);
  return url;
}

// Thumbnails for cards scanned on this device (seller photos from other
// devices and stock images arrive in Phase 4).
let _smCaptureIndex = new Map();   // inventory _dbId → captureId
async function _smLoadCaptureIndex() {
  try {
    const caps = await smStore.all('captures');
    _smCaptureIndex = new Map();
    caps.forEach(c => {
      if (c.seller !== currentSeller || c.deleted) return;
      smThumbUrl(c.id, c.crop);
      if (c.attachedTo) _smCaptureIndex.set(c.attachedTo, c.id);
    });
  } catch (_) {}
}
function _smCardThumb(card) {
  const capId = card._captureId || _smCaptureIndex.get(card._dbId);
  const url = capId && _smThumbUrls.get(capId);
  return url
    ? `<img class="sm-thumb" src="${smEsc(url)}" alt="">`
    : '<div class="sm-thumb" aria-hidden="true"></div>';
}

let _smUploading = false;
async function _smUploadCaptures() {
  if (_smUploading || _smCapturesMissing || !navigator.onLine || typeof db === 'undefined') return;
  _smUploading = true;
  try {
    const uid = await _smGetUid();
    if (!uid) return;
    const caps = (await smStore.all('captures')).filter(c => c.seller === currentSeller && c.rowSynced && !c.deleted);
    for (const cap of caps) {
      const keys = _smCaptureKeys(cap.uid || uid, cap.id);
      const parts = [['crop', keys.crop_key], ['original', keys.original_key], ['back', keys.back_key]];
      let changed = false;
      for (const [part, key] of parts) {
        if (cap.uploaded[part] || !cap[part]) continue;
        const { error } = await db.storage.from('card-captures')
          .upload(key, cap[part], { contentType: 'image/jpeg', upsert: true });
        if (error) { console.warn('[show-mode] photo upload failed', part, error.message); if (!navigator.onLine) return; continue; }
        cap.uploaded[part] = true;
        changed = true;
        if (part === 'original') cap.original = null;   // keep only the small crop on the device
      }
      if (changed) {
        await smStore.put('captures', cap);
        if (cap.uploaded.crop && cap.uploaded.original && cap.uploaded.back) {
          await db.from('card_captures').update({ uploaded_at: new Date().toISOString() }).eq('id', cap.id);
        }
      }
    }
  } catch (e) {
    console.warn('[show-mode] capture upload pass failed', e);
  } finally {
    _smUploading = false;
  }
}

// ── Image helpers ───────────────────────────────────────────────────────────
function _smCanvasBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', quality || 0.85));
}
function _smBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function _smBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
// Draws source rect (sx,sy,sw,sh) of an image/video into a canvas whose long
// edge is at most maxEdge.
function _smDrawScaled(src, sx, sy, sw, sh, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
// A centered 5:7 (card-shaped) crop of a width×height image.
function _smCenterCardRect(w, h) {
  const ratio = 5 / 7;
  let cw = w, ch = w / ratio;
  if (ch > h) { ch = h; cw = h * ratio; }
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}
async function _smImagesFromFile(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { bmp = await createImageBitmap(file); }
  const r = _smCenterCardRect(bmp.width, bmp.height);
  const crop = await _smCanvasBlob(_smDrawScaled(bmp, r.x, r.y, r.w, r.h, 1400));
  const original = await _smCanvasBlob(_smDrawScaled(bmp, 0, 0, bmp.width, bmp.height, 2000));
  if (bmp.close) bmp.close();
  return { crop, original };
}

// ════════════════════════════════════════════════════════════════════════════
// Identification: Claude vision (scan-card.js) and CardSight (cardsight-
// identify.js) run in parallel; agreement raises confidence, disagreement
// turns into "Wrong card?" candidates.
// ════════════════════════════════════════════════════════════════════════════
function _smNormGrader(g) {
  const v = String(g || '').trim();
  if (!v || /^(raw|none|ungraded|null)$/i.test(v)) return '';
  const known = (typeof VALID_GRADERS !== 'undefined' ? VALID_GRADERS : []).find(x => x.toLowerCase() === v.toLowerCase());
  return known || v.toUpperCase();
}
function _smNameTokens(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
function _smNamesAgree(a, b) {
  const ta = _smNameTokens(a), tb = _smNameTokens(b);
  if (!ta.length || !tb.length) return false;
  return ta[ta.length - 1] === tb[tb.length - 1];
}
// "#12" for display; card numbers stored with their own "#" don't get a second one.
function _smCardNum(n) { const v = String(n ?? '').trim().replace(/^#+\s*/, ''); return v ? '#' + v : ''; }
function _smNormNumber(n) { return String(n || '').replace(/^#/, '').replace(/^0+(?=\d)/, '').trim().toLowerCase(); }

async function _smFetchJson(url, body, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function _smFromClaude(card) {
  if (!card) return null;
  const conf = card.confidence || {};
  const vals = ['player_name', 'year', 'set_name'].map(k => Number(conf[k])).filter(v => !isNaN(v));
  const min = vals.length ? Math.min(...vals) : 0;
  let parallel = card.parallel_name || '';
  if (card.parallel_serial) parallel = (parallel + ' ' + card.parallel_serial).trim();
  if (card.autograph && !/auto/i.test(parallel)) parallel = (parallel + ' Auto').trim();
  return {
    source: 'claude',
    player: card.player_name || '',
    year: card.year ? String(card.year) : '',
    cardSet: [card.set_name, card.subset].filter(Boolean).join(' '),
    number: card.card_number || '',
    parallel,
    grader: _smNormGrader(card.grading_company),
    grade: card.grade != null ? String(card.grade) : '',
    cert: card.cert_number || '',
    confidence: min >= 0.85 ? 'high' : min >= 0.6 ? 'medium' : 'low',
  };
}
function _smFromCardSight(det) {
  if (!det) return null;
  return {
    source: 'cardsight',
    catalogCardId: det.catalogCardId || null,
    player: det.player || '',
    year: det.year ? String(det.year) : '',
    cardSet: det.cardSet || '',
    number: det.number || '',
    parallel: det.parallel || '',
    grader: _smNormGrader(det.grader),
    grade: det.grade ? String(det.grade) : '',
    cert: det.certNumber || '',
    confidence: det.confidence || 'low',
  };
}

// Pure merge (exported for tests via window). Returns
// { fields, confidence, catalogCardId, candidates[], sources{} }.
function smMergeIdentification(claude, cardsight, cardsightSuggestions) {
  const c = claude, s = cardsight;
  const sources = { claude: !!c, cardsight: !!s };
  const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b || '');
  let fields, confidence, catalogCardId = null, candidates = [];
  if (c && s && _smNamesAgree(c.player, s.player) &&
      (!c.year || !s.year || c.year.slice(0, 4) === s.year.slice(0, 4))) {
    // Agreement: catalog names for set/number/parallel, Claude for the slab label.
    fields = {
      player: pick(s.player, c.player), year: pick(s.year, c.year), cardSet: pick(s.cardSet, c.cardSet),
      number: pick(s.number, c.number), parallel: pick(s.parallel, c.parallel),
      grader: pick(c.grader, s.grader), grade: pick(c.grade, s.grade), cert: pick(c.cert, s.cert),
    };
    confidence = 'high';
    catalogCardId = s.catalogCardId;
  } else if (c && s) {
    const rank = { high: 3, medium: 2, low: 1 };
    const primary = (rank[s.confidence] || 0) > (rank[c.confidence] || 0) ? s : c;
    const other = primary === s ? c : s;
    fields = Object.assign({}, primary);
    // The slab label read is independent of which catalog match wins.
    fields.grader = pick(c.grader, s.grader); fields.grade = pick(c.grade, s.grade); fields.cert = pick(c.cert, s.cert);
    confidence = primary.confidence === 'high' ? 'medium' : 'low';
    catalogCardId = primary === s ? s.catalogCardId : null;
    candidates = [other];
  } else if (c || s) {
    fields = Object.assign({}, c || s);
    confidence = (c || s).confidence;
    catalogCardId = s ? s.catalogCardId : null;
  } else {
    return { fields: null, confidence: 'none', catalogCardId: null, candidates: [], sources };
  }
  (cardsightSuggestions || []).forEach(sg => {
    const n = _smFromCardSight(sg);
    if (n && n.player) candidates.push(Object.assign(n, { grader: fields.grader, grade: fields.grade, cert: fields.cert }));
  });
  ['source', 'confidence', 'catalogCardId'].forEach(k => delete fields[k]);
  candidates = candidates.map(x => { const y = Object.assign({}, x); delete y.confidence; return y; });
  return { fields, confidence, catalogCardId, candidates, sources };
}

async function smIdentify(cropBlob) {
  const started = performance.now();
  const image_base64 = await _smBlobToBase64(cropBlob);
  const [claudeRes, csRes] = await Promise.allSettled([
    _smFetchJson('/.netlify/functions/scan-card', { image_base64, media_type: 'image/jpeg' }, 11000),
    _smFetchJson('/.netlify/functions/cardsight-identify', { image_base64, media_type: 'image/jpeg' }, 9500),
  ]);
  const claude = claudeRes.status === 'fulfilled' && claudeRes.value && claudeRes.value.success
    ? _smFromClaude(claudeRes.value.card) : null;
  const csOk = csRes.status === 'fulfilled' && csRes.value && csRes.value.success && csRes.value.identified;
  const cs = csOk ? _smFromCardSight(csRes.value.detection) : null;
  const merged = smMergeIdentification(claude, cs, csOk ? csRes.value.detection.suggestions : []);
  merged.latencyMs = Math.round(performance.now() - started);
  return merged;
}

// ════════════════════════════════════════════════════════════════════════════
// Matching against the seller's own available inventory: cert number first
// (slabs), then player/year/number/set/grade.
// ════════════════════════════════════════════════════════════════════════════
function _smAvailable() { return getSellerInventory().filter(r => r.Status !== 'Sold'); }

function smScoreMatch(card, f) {
  if (!f) return 0;
  const cert = String(f.cert || '').replace(/\s/g, '');
  if (cert && String(card['Cert #'] || '').replace(/\s/g, '') === cert) return 100;
  let score = 0;
  const cardPlayer = card.Player || card['Card Title'] || '';
  if (_smNamesAgree(cardPlayer, f.player)) {
    score += 40;
    const a = _smNameTokens(cardPlayer).join(' '), b = _smNameTokens(f.player).join(' ');
    if (a && a === b) score += 10;
  }
  if (f.year && card.Year && String(card.Year).slice(0, 4) === String(f.year).slice(0, 4)) score += 20;
  if (f.number && _smNormNumber(card.Number || card['Card #']) === _smNormNumber(f.number)) score += 20;
  const setTokens = new Set(_smNameTokens(card['Set '] || card.Set));
  score += Math.min(15, _smNameTokens(f.cardSet).filter(t => setTokens.has(t)).length * 5);
  const cg = _smNormGrader(card.Grader), fg = _smNormGrader(f.grader);
  if (cg && fg) score += (cg === fg && String(card.Grade) === String(f.grade)) ? 15 : -30;
  else if (!!cg !== !!fg) score -= 15;
  return score;
}

function smMatchInventory(fields) {
  return _smAvailable()
    .map(card => ({ card, score: smScoreMatch(card, fields) }))
    .filter(m => m.score >= SM_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ════════════════════════════════════════════════════════════════════════════
// Entry points, routing, open/close
// ════════════════════════════════════════════════════════════════════════════
function _smAuthorizedShows() {
  return Object.values(shows).filter(s => s.sellers instanceof Set && s.sellers.has(currentSeller));
}
function _smDefaultShowId() {
  const mine = _smAuthorizedShows();
  if (activeShowId && mine.some(s => s.id === activeShowId)) return activeShowId;
  const today = mine.find(s => _showIsToday(s));
  return today ? today.id : null;
}

function smUpdateEntryPoints() {
  const btn = document.getElementById('navShowModeBtn');
  if (!btn) return;
  btn.style.display = (smIsEnabled() && currentRole === 'seller' && _smAuthorizedShows().length) ? '' : 'none';
}

function smOpenFromNav() {
  const id = _smDefaultShowId() || (_smAuthorizedShows()[0] || {}).id;
  if (id) openShowMode(id);
  else showToast('You haven\'t been added to a show yet', 'gold');
}

// Runs once shows{} is loaded on seller login: reopens Show Mode after a
// refresh (#/sm/<showId>/<screen>), or opens it on its own when a show the
// seller is in runs today, unless they switched to classic view today. Also
// replays anything left in the outbox from an earlier session.
function smAfterShowsLoaded() {
  smUpdateEntryPoints();
  if (!smIsEnabled() || currentRole !== 'seller') return;
  smDrain();
  if (typeof scResume === 'function') scResume();
  const m = location.hash.match(SM_HASH_RE);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (_smAuthorizedShows().some(s => s.id === id)) { openShowMode(id, m[2] || ''); return; }
    _smClearHash();
  }
  const id = _smDefaultShowId();
  if (id && _smExitedToday() !== id) openShowMode(id);
}

function _smExitKey() { return 'smExited:' + currentSeller; }
function _smExitedToday() {
  try {
    const [id, day] = (localStorage.getItem(_smExitKey()) || '').split('|');
    return day === _todayISO() ? id : null;
  } catch (_) { return null; }
}
function _smClearHash() {
  if (SM_HASH_RE.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}
function _smPath() {
  const m = location.hash.match(SM_HASH_RE);
  return m ? (m[2] || '') : '';
}

function smGo(path, replace) {
  const hash = '#/sm/' + encodeURIComponent(_smShowId) + (path || '');
  if (replace) { history.replaceState(null, '', location.pathname + location.search + hash); smRoute(); }
  else if (location.hash === hash) smRoute();
  else location.hash = hash;   // hashchange → smRoute()
}

window.addEventListener('hashchange', () => {
  if (!_smShowId) return;
  const m = location.hash.match(SM_HASH_RE);
  if (!m || decodeURIComponent(m[1]) !== _smShowId) { closeShowMode(); return; }
  smRoute();
});

function openShowMode(showId, path) {
  if (!smIsEnabled() || !shows[showId]) return;
  _smShowId = showId;
  try { localStorage.removeItem(_smExitKey()); } catch (_) {}
  history.replaceState(null, '', location.pathname + location.search + '#/sm/' + encodeURIComponent(showId) + (path || ''));
  document.getElementById('showModeRoot').classList.add('open');
  document.body.classList.add('sm-open');
  if (typeof closeHelpMenu === 'function') closeHelpMenu();
  _smGetUid();
  _smLoadCaptureIndex().then(() => { smRefresh(); if (_smScreen === 'confirm') smRenderConfirm(); });
  _smLoadRecentSaleIds();
  smRoute();
  _smLogEvent('show_mode_opened', {});
}

// remember: true when the seller chose classic view (so it doesn't reopen
// itself again today). Sign-out and admin login close it without remembering.
function closeShowMode(opts) {
  const root = document.getElementById('showModeRoot');
  if (!root) return;
  if (opts && opts.remember && _smShowId) {
    try { localStorage.setItem(_smExitKey(), _smShowId + '|' + _todayISO()); } catch (_) {}
  }
  smStopCamera();
  smCloseMore();
  smHideToast();
  root.classList.remove('open');
  document.body.classList.remove('sm-open');
  _smShowId = null;
  _smClearHash();
}

function smOpenClassic(tab) {
  closeShowMode({ remember: true });
  switchSellerTab(tab === 'report' ? 'report' : 'inventory');
  window.scrollTo(0, 0);
}

function smOpenMore()  { document.getElementById('smMoreBackdrop').classList.add('open'); }
function smCloseMore() { const b = document.getElementById('smMoreBackdrop'); if (b) b.classList.remove('open'); }
// Screens that use the single-card camera: sell, log a sale, add one card.
function _smIsCameraScreen(screen) { return screen === 'sell' || screen === 'log' || screen === 'addone'; }

// Re-render whatever is on screen after data changes (called by updateStats()
// and after the outbox drains). The camera screen is left alone.
function smRefresh() {
  if (!_smShowId) return;
  if (_smScreen === 'home') smRenderHome();
  else if (_smScreen === 'inventory') smRenderInventoryList();
  else if (_smScreen === 'sold') smRenderSold();
}

function smRoute() {
  if (!_smShowId) return;
  const path = _smPath();
  const parts = path.split('/').filter(Boolean);
  const screen = parts[0] || 'home';
  const caseCamera = typeof scIsCameraRoute === 'function' && scIsCameraRoute(parts);
  if (!_smIsCameraScreen(screen) && !caseCamera) smStopCamera();
  smCloseMore();
  smCloseAddSheet();
  if (screen !== 'sold') smHideToast();
  const root = document.getElementById('showModeRoot');
  root.classList.toggle('sm-dark', _smIsCameraScreen(screen) || caseCamera);
  const navVisible = screen === 'home' || screen === 'inventory';
  document.getElementById('smBottomNav').style.display = navVisible ? '' : 'none';
  document.querySelectorAll('#smBottomNav .sm-nav-item[data-screen]').forEach(b => {
    const on = b.dataset.screen === screen;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.getElementById('smScroll').scrollTop = 0;
  _smScreen = screen;
  switch (screen) {
    case 'sell':      return smRenderSell('sell');
    case 'log':       return smRenderSell('manual');
    case 'addone':    return smRenderSell('add');
    case 'addtype':   return smRenderAddType();
    case 'confirm':   return smRenderConfirm();
    case 'sold':      return smRenderSold(parts[1]);
    case 'inventory': return smRenderInventory();
    case 'scans':     return smRenderScans();
    case 'add':       return scRoute(parts);
    default:          _smScreen = 'home'; return smRenderHome();
  }
}

function _smView() { return document.getElementById('smView'); }

// ════════════════════════════════════════════════════════════════════════════
// Screen 1: Show Mode home
// ════════════════════════════════════════════════════════════════════════════
function _smShowDay(show) {
  if (!_showIsToday(show)) return null;
  const startISO = show.startDate || _showDateISO(show);
  if (!startISO) return 1;
  const start = new Date(startISO + 'T00:00:00');
  const today = new Date(_todayISO() + 'T00:00:00');
  return Math.round((today - start) / 86400000) + 1;
}
function _smSaleTime(r) {
  if (r._saleAt) return new Date(r._saleAt);
  const key = _txSortKey(r);
  if (!key) return null;
  const d = new Date(key);
  return isNaN(d) ? null : d;
}
function _smRelTime(d) {
  if (!d) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 24 * 60 && d.toLocaleDateString('en-CA') === _todayISO()) return Math.round(mins / 60) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function _smGradeLabel(r) {
  return r.Grader ? `${r.Grader} ${r.Grade ?? ''}`.trim() : (r.Grade ? String(r.Grade) : 'Raw');
}
function _smCanUndo(r) {
  return !!r._clientSaleId && r.Status === 'Sold' && r._saleAt && (Date.now() - r._saleAt) < SM_UNDO_WINDOW_MS;
}

function smRenderHome() {
  const el = _smView();
  const show = shows[_smShowId];
  if (!el || !show) return;
  const today = _todayISO();
  const mine = getSellerInventory();
  const soldToday = mine.filter(r => r.Status === 'Sold' && r.SoldDate === today);
  const salesTotal = soldToday.reduce((s, r) => s + (Number(r.SoldPrice) || 0), 0);
  const available = mine.filter(r => r.Status !== 'Sold');
  const onShow = available.filter(r => r._shows instanceof Set && r._shows.has(show.id)).length;

  const day = _smShowDay(show);
  const table = show.tables && show.tables[currentSeller];
  const metaBits = [];
  if (table) metaBits.push('Table ' + smEsc(table));
  metaBits.push(day ? 'Day ' + day : smEsc(show.date || ''));

  const recent = mine.filter(r => r.Status === 'Sold')
    .sort((a, b) => (_smSaleTime(b) || 0) - (_smSaleTime(a) || 0))
    .slice(0, 5);
  const recentHTML = recent.length ? recent.map(r => {
    const name = r.Player || r['Card Title'] || 'Card';
    const meta = [_smMoney(r.SoldPrice), r.PaymentMethod, _smRelTime(_smSaleTime(r))].filter(Boolean).map(smEsc).join(' · ');
    const sync = r._smPending ? '<span class="sm-sync">Syncing</span>' : '';
    const undo = _smCanUndo(r)
      ? `<button class="sm-row-btn sm-row-btn--ghost" onclick="smUndoSale('${smEsc(r._clientSaleId)}')">Undo</button>` : '';
    return `<div class="sm-row">
      ${_smCardThumb(r)}
      <div class="sm-row-body">
        <div class="sm-row-title">${smEsc(name)} · ${smEsc(_smGradeLabel(r))}</div>
        <div class="sm-row-meta">${meta} ${sync}</div>
      </div>${undo}
    </div>`;
  }).join('') : '<div class="sm-empty">No sales yet. Your sales show up here.</div>';

  const notice = (!onShow && available.length) ? `
    <div class="sm-notice">
      Your cards aren't on this show yet, so buyers can't see them.
      <div><button class="sm-notice-btn" onclick="sellerPublishToShow('${smEsc(show.id)}')">Add my cards to this show</button></div>
    </div>` : '';

  el.innerHTML = `
    ${_smHeaderHTML()}
    <div class="sm-live">
      <div class="sm-live-top">
        <span class="sm-live-tag ${day ? '' : 'off'}"><span class="sm-live-dot" aria-hidden="true"></span>${day ? 'Live now' : 'Not live today'}</span>
        <button class="sm-share-btn" onclick="smShareShowLink()">${_smIcon('share')}Share link</button>
      </div>
      <div class="sm-live-name">${smEsc(show.name)}</div>
      <div class="sm-live-meta">${metaBits.join(' · ')}</div>
    </div>
    <div class="sm-stats" aria-live="polite">
      <div class="sm-stat"><div class="sm-stat-num">${soldToday.length}</div><div class="sm-stat-label">Sold today</div></div>
      <div class="sm-stat"><div class="sm-stat-num">${_smMoney(salesTotal)}</div><div class="sm-stat-label">Sales</div></div>
      <div class="sm-stat"><div class="sm-stat-num">${available.length}</div><div class="sm-stat-label">In case</div></div>
    </div>
    ${notice}
    <button class="sm-hero" onclick="smStartSell('home_cta')">
      <span class="sm-hero-tile">${_smIcon('scan')}</span>
      <span>
        <span class="sm-hero-title" style="display:block">Sell a card</span>
        <span class="sm-hero-sub" style="display:block">Scan it or search it. Done in 3 taps.</span>
      </span>
    </button>
    <div class="sm-secondary">
      ${typeof scHomeBannerHTML === 'function' ? scHomeBannerHTML() : ''}
      <button class="sm-sec-btn" onclick="smOpenAddSheet()" aria-haspopup="dialog">${_smIcon('plus')}Add cards${_smIcon('chev', 'sm-chev')}</button>
      <button class="sm-sec-btn" onclick="smStartManualSale()">${_smIcon('pen')}Log a manual sale${_smIcon('chev', 'sm-chev')}</button>
      <button class="sm-sec-btn" onclick="smRefreshPrices()">${_smIcon('refresh')}Refresh prices${_smIcon('chev', 'sm-chev')}</button>
    </div>
    <div class="sm-section-label">Recent sales</div>
    <div class="sm-list">${recentHTML}</div>`;
}

function _smHeaderHTML() {
  return `<div class="sm-header">
    <div class="sm-wordmark">Card<span>Show</span></div>
    <button class="sm-icon-btn" onclick="openProfile()" aria-label="Your account">${_smIcon('user')}</button>
  </div>`;
}

function smGoHome() { smGo('', false); }

async function smShareShowLink() {
  const show = shows[_smShowId];
  if (!show) return;
  const url = _showPageUrl(show.id);
  if (navigator.share) {
    try { await navigator.share({ title: show.name, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); showToast('Show link copied'); }
  catch (_) { showToast(url); }
}

function smRefreshPrices() {
  const list = _smAvailable();
  if (!list.length) { showToast('No cards to price yet', 'gold'); return; }
  // The comp check's progress bar lives in the inventory view, so go there.
  smOpenClassic('inventory');
  runCompCheck(list);
}

// Sales from the last 10 minutes, so Undo survives a refresh.
async function _smLoadRecentSaleIds() {
  if (typeof db === 'undefined' || !navigator.onLine) return;
  const since = new Date(Date.now() - SM_UNDO_WINDOW_MS).toISOString();
  const { data, error } = await db.from('sales')
    .select('client_sale_id, inventory_id, sold_at, status, capture_id')
    .eq('status', 'completed').gte('sold_at', since);
  if (error || !data) return;
  data.forEach(s => {
    const card = inventory.find(c => c._dbId === s.inventory_id);
    if (card && card.Status === 'Sold' && !card._clientSaleId) {
      card._clientSaleId = s.client_sale_id;
      card._saleAt = Date.parse(s.sold_at);
      if (s.capture_id) card._captureId = s.capture_id;
    }
  });
  smRefresh();
}

// ════════════════════════════════════════════════════════════════════════════
// Screen 2: scan or search to sell (also "Log a sale" manual mode)
// ════════════════════════════════════════════════════════════════════════════
// The selling context, kept across screens 2 → 3 → 4 and in sessionStorage so
// a refresh on the confirm screen comes back to the same card and values.
let _smDraft = null;
let _smStream = null;
let _smTorch = false;
let _smSellMode = 'scan';
let _smSearchFilter = '';
let _smSellStartedAt = 0;
let _smLastResult = null;    // { capture, ident, matches }

function _smSaveDraft() {
  try {
    if (!_smDraft) { sessionStorage.removeItem('smDraft'); return; }
    const d = Object.assign({}, _smDraft);
    delete d.card;
    sessionStorage.setItem('smDraft', JSON.stringify(d));
  } catch (_) {}
}
function _smLoadDraft() {
  if (_smDraft) return _smDraft;
  try {
    const d = JSON.parse(sessionStorage.getItem('smDraft') || 'null');
    if (d && d.showId === _smShowId) _smDraft = d;
  } catch (_) {}
  return _smDraft;
}
function _smDraftCard(d) {
  if (!d || !d.itemKey) return null;
  return inventory.find(c => c._dbId === d.itemKey && c.Seller === currentSeller) || null;
}

function smStartSell(entry) {
  _smLogEvent('sell_started', { entry });
  _smSellStartedAt = Date.now();
  if (!_smShowId) return;
  smGo('/sell');
}
function smStartManualSale() {
  _smSellStartedAt = Date.now();
  smGo('/log');
}

function smRenderSell(mode) {
  _smLastResult = null;
  const manual = mode === 'manual';
  const adding = mode === 'add';
  const title = adding ? 'Add a card' : (manual ? 'Log a sale' : 'Sell a card');
  const el = _smView();
  el.innerHTML = `
    <div class="sm-dark-header">
      <button class="sm-dark-btn" onclick="smGoHome()" aria-label="Close">${_smIcon('close')}</button>
      ${adding ? '<span></span>' : `<div class="sm-seg" role="tablist" aria-label="${title}">
        <button role="tab" id="smSegScan" aria-selected="${_smSellMode === 'scan'}" onclick="smSetSellMode('scan')">Scan</button>
        <button role="tab" id="smSegSearch" aria-selected="${_smSellMode === 'search'}" onclick="smSetSellMode('search')">Search</button>
      </div>`}
      <button class="sm-dark-btn" id="smFlashBtn" onclick="smToggleTorch()" aria-label="Flash" aria-pressed="false" style="visibility:hidden">${_smIcon('flash')}</button>
    </div>
    <div class="sm-sell-title">${title}${adding && _smAddedCount ? ` <span class="sm-added-count">${_smAddedCount} added</span>` : ''}</div>
    <div id="smSellBody"></div>
    <div id="smResultSheet"></div>
    <div class="sm-sr-only" aria-live="polite" id="smLive"></div>
    <input type="file" id="smFileInput" accept="image/*" style="display:none" onchange="smHandleFile(this)">`;
  _smRenderSellBody(manual, adding);
}

function smSetSellMode(m) {
  _smSellMode = m;
  document.getElementById('smSegScan')?.setAttribute('aria-selected', m === 'scan');
  document.getElementById('smSegSearch')?.setAttribute('aria-selected', m === 'search');
  _smRenderSellBody(_smScreen === 'log');
}

// adding: the one-card add screen is camera only (typing has its own screen).
function _smRenderSellBody(manual, adding) {
  const body = document.getElementById('smSellBody');
  if (!body) return;
  document.getElementById('smResultSheet').innerHTML = '';
  if (adding || _smSellMode === 'scan') {
    body.innerHTML = `
      <div class="sm-camera" id="smCamera">
        <video id="smVideo" playsinline muted autoplay></video>
        <div class="sm-guide" id="smGuide" aria-hidden="true"></div>
        <div class="sm-camera-msg" id="smCameraMsg"></div>
      </div>
      <div class="sm-camera-caption">Hold the card or slab in the frame</div>
      <div class="sm-shutter-row">
        <button class="sm-dark-btn sm-dark-btn--text" onclick="document.getElementById('smFileInput').click()">${_smIcon('image')}<span>Photo</span></button>
        <button class="sm-shutter" id="smShutter" onclick="smCapture()" aria-label="Take photo"></button>
        <span style="width:64px"></span>
      </div>
      ${_smScreen === 'addone' ? `<div class="sm-links"><button class="sm-link sm-link--on-dark" onclick="smStartAddType()">Type it in instead</button></div>` : ''}`;
    smStartCamera();
  } else {
    smStopCamera();
    body.innerHTML = `
      <div class="sm-search-wrap">
        <label class="sm-sr-only" for="smSearchInput">Search your inventory</label>
        <div class="sm-search">${_smIcon('search')}<input id="smSearchInput" type="search" autocomplete="off"
          placeholder="Player, set, card #, or cert #" oninput="smRenderSearchResults()"></div>
        <div class="sm-chips" role="group" aria-label="Filter">
          ${['Graded', 'Raw', 'Sealed'].map(f => `<button class="sm-chip" aria-pressed="${_smSearchFilter === f}" onclick="smSetSearchFilter('${f}')">${f}</button>`).join('')}
        </div>
        <div class="sm-list sm-list--light" id="smSearchResults"></div>
        <button class="sm-sec-btn sm-sec-btn--dark" onclick="smGo('/scans')">${_smIcon('image')}Recent scans${_smIcon('chev', 'sm-chev')}</button>
        ${manual ? `<button class="sm-sec-btn sm-sec-btn--dark" onclick="smTypeItIn()">${_smIcon('pen')}Not in your inventory? Type it in${_smIcon('chev', 'sm-chev')}</button>` : ''}
      </div>`;
    smRenderSearchResults();
    setTimeout(() => document.getElementById('smSearchInput')?.focus(), 50);
  }
}

function smSetSearchFilter(f) {
  _smSearchFilter = _smSearchFilter === f ? '' : f;
  document.querySelectorAll('#smSellBody .sm-chip').forEach(b => b.setAttribute('aria-pressed', b.textContent === _smSearchFilter));
  smRenderSearchResults();
}

function _smSearchCards(q, filter) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return _smAvailable().filter(r => {
    if (filter === 'Graded' && !r.Grader) return false;
    if (filter === 'Raw' && (r.Grader || (r.item_type && r.item_type !== 'card'))) return false;
    if (filter === 'Sealed' && r.item_type !== 'sealed') return false;
    if (!words.length) return true;
    const hay = [r['Card Title'], r.Player, r.Year, r['Set '], r.Number, r['Parallel/Variant'], r.Grader, r.Grade, r['Cert #']]
      .map(v => String(v ?? '').toLowerCase()).join(' ');
    return words.every(w => hay.includes(w));
  });
}

function smRenderSearchResults() {
  const box = document.getElementById('smSearchResults');
  if (!box) return;
  const q = document.getElementById('smSearchInput')?.value || '';
  const res = _smSearchCards(q, _smSearchFilter);
  box.innerHTML = res.length ? res.slice(0, 50).map(r => `
    <button class="sm-row sm-row--button" onclick="smPickCard('${smEsc(r._dbId || '')}', 'search')">
      ${_smCardThumb(r)}
      <span class="sm-row-body">
        <span class="sm-row-title">${smEsc(r.Player || r['Card Title'] || 'Card')}</span>
        <span class="sm-row-meta">${smEsc([r.Year, r['Set '], _smCardNum(r.Number), _smGradeLabel(r)].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="sm-row-price">${_smMoney(r.Price)}</span>
    </button>`).join('') + (res.length > 50 ? `<div class="sm-empty">${res.length - 50} more — keep typing to narrow it down</div>` : '')
    : `<div class="sm-empty">${q ? 'No cards in your case match that.' : 'Nothing available in your case.'}</div>`;
}

// Picking a card from search (or a scan match) → confirm screen.
function smPickCard(dbId, mode, captureId) {
  const card = inventory.find(c => c._dbId === dbId);
  if (!card) { showToast('This card hasn\'t synced yet — try again in a moment', 'gold'); return; }
  _smDraft = {
    showId: _smShowId, mode: _smScreen === 'log' ? 'manual' : 'sell',
    itemKey: card._dbId, newItem: null, captureId: captureId || null,
    chip: 'asking', otherPrice: '', payment: _smLastPayment(), buyerHandle: '', identifiedVia: mode,
  };
  _smSaveDraft();
  smGo('/confirm');
}

function smTypeItIn() {
  _smDraft = {
    showId: _smShowId, mode: 'manual', itemKey: null,
    newItem: { player: '', year: '', cardSet: '', number: '', parallel: '', grader: '', grade: '', cert: '', asking: '' },
    captureId: null, chip: 'other', otherPrice: '', payment: _smLastPayment(), buyerHandle: '', identifiedVia: 'manual',
  };
  _smSaveDraft();
  smGo('/confirm');
}

// ── Camera ──────────────────────────────────────────────────────────────────
async function smStartCamera() {
  const video = document.getElementById('smVideo');
  const msg = document.getElementById('smCameraMsg');
  if (!video) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (msg) msg.textContent = 'Camera not available here. Use Photo to pick an image.';
    return;
  }
  try {
    if (!_smStream) {
      _smStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    }
    if (!document.getElementById('smVideo')) { smStopCamera(); return; }   // left the screen meanwhile
    video.srcObject = _smStream;
    await video.play().catch(() => {});
    const track = _smStream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const flash = document.getElementById('smFlashBtn');
    if (flash) flash.style.visibility = caps.torch ? 'visible' : 'hidden';
  } catch (e) {
    console.warn('[show-mode] camera', e);
    if (msg) msg.textContent = 'Camera blocked. Allow camera access, or use Photo to pick an image.';
  }
}
function smStopCamera() {
  if (_smStream) { _smStream.getTracks().forEach(t => t.stop()); _smStream = null; }
  _smTorch = false;
}
async function smToggleTorch() {
  const track = _smStream && _smStream.getVideoTracks()[0];
  if (!track) return;
  _smTorch = !_smTorch;
  try { await track.applyConstraints({ advanced: [{ torch: _smTorch }] }); } catch (_) { _smTorch = false; }
  document.getElementById('smFlashBtn')?.setAttribute('aria-pressed', _smTorch);
}

// Maps the on-screen guide frame onto the video's own pixels (the video is
// object-fit: cover, so part of the frame is off-screen).
function _smGuideRectInVideo(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const vr = video.getBoundingClientRect(), gr = guide.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2, offY = (vr.height - vh * scale) / 2;
  let x = (gr.left - vr.left - offX) / scale, y = (gr.top - vr.top - offY) / scale;
  let w = gr.width / scale, h = gr.height / scale;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  return { x, y, w, h };
}

async function smCapture(isBack) {
  const video = document.getElementById('smVideo');
  const guide = document.getElementById('smGuide');
  if (!video || !video.videoWidth) { document.getElementById('smFileInput')?.click(); return; }
  const r = _smGuideRectInVideo(video, guide);
  const crop = await _smCanvasBlob(_smDrawScaled(video, r.x, r.y, r.w, r.h, 1400));
  if (isBack) return crop;
  const original = await _smCanvasBlob(_smDrawScaled(video, 0, 0, video.videoWidth, video.videoHeight, 2000));
  if (navigator.vibrate) navigator.vibrate(15);
  return _smProcessScan(crop, original);
}

async function smHandleFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const { crop, original } = await _smImagesFromFile(file);
    if (_smAddingBack) { _smAddingBack = false; return _smAttachBack(crop); }
    return _smProcessScan(crop, original);
  } catch (e) {
    console.warn('[show-mode] photo read failed', e);
    showToast('Couldn\'t read that photo', 'var(--danger)');
  }
}

async function _smProcessScan(crop, original) {
  const manual = _smScreen === 'log';
  // One-card adds are stored as 'case_scan' (the entry_point check allows
  // sell_card / manual_sale / case_scan, and this is an add to the case).
  const entryPoint = _smScreen === 'addone' ? 'case_scan' : (manual ? 'manual_sale' : 'sell_card');
  const sheet = document.getElementById('smResultSheet');
  const shutter = document.getElementById('smShutter');
  if (shutter) shutter.disabled = true;
  const capture = await smSaveCapture({ crop, original, entryPoint });
  const thumb = smThumbUrl(capture.id, crop);
  if (sheet) sheet.innerHTML = `
    <div class="sm-sheet-card">
      <div class="sm-result-top"><span class="sm-saved">${_smIcon('check')}Photo saved</span></div>
      <div class="sm-result-main">
        <img class="sm-result-img" src="${smEsc(thumb)}" alt="">
        <div><div class="sm-result-name">Identifying…</div><div class="sm-row-meta">This takes a few seconds</div></div>
      </div>
      <div class="sm-spinner" aria-hidden="true"></div>
    </div>`;
  _smAnnounce('Photo saved. Identifying the card.');

  let ident;
  if (!navigator.onLine) {
    ident = { fields: null, confidence: 'none', candidates: [], sources: {}, offline: true };
  } else {
    try { ident = await smIdentify(crop); }
    catch (e) { console.warn('[show-mode] identify failed', e); ident = { fields: null, confidence: 'none', candidates: [], sources: {} }; }
  }
  if (!_smIsCameraScreen(_smScreen)) return;   // seller left meanwhile
  if (shutter) shutter.disabled = false;

  const matches = ident.fields ? smMatchInventory(ident.fields) : [];
  _smLastResult = { capture, ident, matches };
  if (ident.fields) {
    await smUpdateCapture(capture.id, { identification: ident }, {
      identification: ident, catalog_card_id: ident.catalogCardId || null, cert_number: ident.fields.cert || null,
      grader: ident.fields.grader || null, grade: ident.fields.grade || null, confidence: ident.confidence,
    });
  }
  _smLogEvent('card_identified', {
    mode: 'scan', inInventory: matches.length > 0, latencyMs: ident.latencyMs || null,
    confidence: ident.confidence, claude: !!ident.sources.claude, cardsight: !!ident.sources.cardsight,
  });
  _smRenderResult();
}

function _smAnnounce(text) {
  const live = document.getElementById('smLive');
  if (live) live.textContent = text;
}

function _smRenderResult() {
  const sheet = document.getElementById('smResultSheet');
  const r = _smLastResult;
  if (!sheet || !r) return;
  if (_smScreen === 'addone') return _smRenderAddResult();
  const manual = _smScreen === 'log';
  const thumb = _smThumbUrls.get(r.capture.id);
  if (!r.ident.fields) {
    sheet.innerHTML = `
      <div class="sm-sheet-card">
        <div class="sm-result-top"><span class="sm-saved">${_smIcon('check')}Photo saved</span></div>
        <div class="sm-result-main">
          <img class="sm-result-img" src="${smEsc(thumb)}" alt="">
          <div><div class="sm-result-name">${r.ident.offline ? 'No signal — can\'t identify right now' : 'Couldn\'t read this card'}</div>
          <div class="sm-row-meta">The photo is kept in Recent scans.</div></div>
        </div>
        <button class="sm-primary" onclick="smRetryScan()">Try again</button>
        <div class="sm-links">
          <button class="sm-link" onclick="smSetSellMode('search')">Search instead</button>
          <button class="sm-link" onclick="smUseScanAsNew()">Type the details in</button>
        </div>
      </div>`;
    _smAnnounce('Could not identify the card.');
    return;
  }
  const f = r.ident.fields;
  const match = r.matches[0] && r.matches[0].card;
  const inCase = !!match;
  const show = match || null;
  const name = show ? (show.Player || show['Card Title']) : f.player;
  const meta = show
    ? [show['Set '], _smCardNum(show.Number), _smGradeLabel(show)].filter(Boolean).join(' · ')
    : [f.cardSet, _smCardNum(f.number), f.grader ? `${f.grader} ${f.grade}`.trim() : 'Raw'].filter(Boolean).join(' · ');
  const primaryLabel = manual ? 'Log this sale →' : (inCase ? 'Sell this card →' : 'Add & sell →');
  sheet.innerHTML = `
    <div class="sm-sheet-card">
      <div class="sm-result-top">
        <span class="sm-badge ${inCase ? 'sm-badge--ok' : 'sm-badge--warn'}">${inCase ? 'In your case' : 'Not in your case'}</span>
        <span class="sm-saved">${_smIcon('check')}Photo saved</span>
      </div>
      <div class="sm-result-main">
        <img class="sm-result-img" src="${smEsc(thumb)}" alt="">
        <div>
          <div class="sm-result-name">${smEsc(name || 'Unknown card')}</div>
          <div class="sm-row-meta">${smEsc(meta)}</div>
          <div class="sm-row-meta" id="smResultPrice">${inCase ? 'Your price ' + _smMoney(show.Price) + ' · ' : ''}Market <span id="smResultMarket">…</span></div>
        </div>
      </div>
      <button class="sm-primary" onclick="smResultPrimary()">${primaryLabel}</button>
      <div class="sm-links">
        <button class="sm-link" onclick="smShowCandidates()">Wrong card?</button>
        <button class="sm-link" onclick="smAddBackPhoto()">Add back photo</button>
        ${manual ? '' : '<button class="sm-link" onclick="showToast(\'Selling several cards at once is coming soon\', \'gold\')">Sell several (bundle)</button>'}
      </div>
      <div id="smCandidates"></div>
    </div>`;
  _smAnnounce(`${inCase ? 'In your case' : 'Not in your case'}: ${name || 'card'}`);
  _smFillMarket(show || _smFieldsToCard(f), 'smResultMarket');
}

function smRetryScan() {
  document.getElementById('smResultSheet').innerHTML = '';
  _smLastResult = null;
}

const _smMarketCache = new Map();
async function _smMarketFor(card) {
  const key = cardFingerprint(card);
  if (_smMarketCache.has(key)) return _smMarketCache.get(key);
  const p = fetchBuyerComp(card).then(r => (r && r.compPrice ? Number(r.compPrice) : null)).catch(() => null);
  _smMarketCache.set(key, p);
  return p;
}
async function _smFillMarket(card, elId) {
  const v = navigator.onLine ? await _smMarketFor(card) : null;
  const el = document.getElementById(elId);
  if (el) el.textContent = v ? _smMoney(v) : '—';
  return v;
}

function _smFieldsToCard(f) {
  return {
    Player: f.player || '', Year: f.year || '', 'Set ': f.cardSet || '', Number: f.number || '',
    'Parallel/Variant': f.parallel || '', Grader: f.grader || null, Grade: f.grade || null,
    'Cert #': f.cert || null, 'Card Title': '',
  };
}

function smResultPrimary() {
  const r = _smLastResult;
  if (!r) return;
  const match = r.matches[0] && r.matches[0].card;
  if (match) return smPickCard(match._dbId, 'scan', r.capture.id);
  smUseScanAsNew();
}

function smUseScanAsNew(candidateIdx) {
  const r = _smLastResult;
  const f = (r && r.ident.fields) ? Object.assign({}, r.ident.fields) : {};
  if (candidateIdx != null && r && r.ident.candidates[candidateIdx]) Object.assign(f, r.ident.candidates[candidateIdx]);
  _smDraft = {
    showId: _smShowId, mode: _smScreen === 'log' ? 'manual' : 'sell', itemKey: null,
    newItem: {
      player: f.player || '', year: f.year || '', cardSet: f.cardSet || '', number: f.number || '',
      parallel: f.parallel || '', grader: f.grader || '', grade: f.grade || '', cert: f.cert || '', asking: '',
      catalogCardId: (r && r.ident.catalogCardId) || null,
    },
    captureId: r ? r.capture.id : null, chip: 'other', otherPrice: '', payment: _smLastPayment(), buyerHandle: '',
    identifiedVia: 'scan',
  };
  _smSaveDraft();
  smGo('/confirm');
}

function smShowCandidates() {
  const box = document.getElementById('smCandidates');
  const r = _smLastResult;
  if (!box || !r) return;
  const rows = [];
  r.matches.slice(1).forEach(m => rows.push(`
    <button class="sm-row sm-row--button" onclick="smPickCard('${smEsc(m.card._dbId)}', 'scan', '${smEsc(r.capture.id)}')">
      ${_smCardThumb(m.card)}
      <span class="sm-row-body"><span class="sm-row-title">${smEsc(m.card.Player || m.card['Card Title'])}</span>
      <span class="sm-row-meta">In your case · ${smEsc([m.card['Set '], _smGradeLabel(m.card)].filter(Boolean).join(' · '))}</span></span>
    </button>`));
  r.ident.candidates.forEach((c, i) => rows.push(`
    <button class="sm-row sm-row--button" onclick="smUseScanAsNew(${i})">
      <span class="sm-row-body"><span class="sm-row-title">${smEsc(c.player || 'Unknown')}</span>
      <span class="sm-row-meta">${smEsc([c.year, c.cardSet, _smCardNum(c.number), c.parallel].filter(Boolean).join(' · '))}</span></span>
    </button>`));
  if (r.matches[0]) rows.push(`<button class="sm-row sm-row--button" onclick="smUseScanAsNew()"><span class="sm-row-body"><span class="sm-row-title">It's not in my case</span><span class="sm-row-meta">Add it and sell it</span></span></button>`);
  rows.push(`<button class="sm-row sm-row--button" onclick="smSetSellMode('search')"><span class="sm-row-body"><span class="sm-row-title">Search instead</span></span></button>`);
  box.innerHTML = `<div class="sm-section-label" style="margin-top:12px">Other matches</div><div class="sm-list">${rows.join('')}</div>`;
}

// Back photo: one more frame into the same capture.
let _smAddingBack = false;
async function smAddBackPhoto() {
  const r = _smLastResult;
  if (!r) return;
  const video = document.getElementById('smVideo');
  if (!video || !video.videoWidth) { _smAddingBack = true; document.getElementById('smFileInput').click(); return; }
  showToast('Flip the card, then tap the shutter', 'gold');
  const shutter = document.getElementById('smShutter');
  shutter.onclick = async () => {
    shutter.onclick = () => smCapture();
    const crop = await smCapture(true);
    _smAttachBack(crop);
  };
}
async function _smAttachBack(blob) {
  const r = _smLastResult;
  if (!r || !blob) return;
  const cap = await smStore.get('captures', r.capture.id).catch(() => null);
  if (cap) {
    cap.back = blob;
    cap.uploaded.back = false;
    await smStore.put('captures', cap);
  }
  const uid = await _smGetUid();
  await smEnqueue({ type: 'capture_update', captureId: r.capture.id, fields: { back_key: _smCaptureKeys(uid, r.capture.id).back_key } });
  showToast('Back photo saved');
}

// ════════════════════════════════════════════════════════════════════════════
// Screen 3: confirm sale
// ════════════════════════════════════════════════════════════════════════════
function _smLastPaymentKey() { return 'smLastPay:' + currentSeller; }
function _smLastPayment() {
  try { const v = localStorage.getItem(_smLastPaymentKey()); return SM_PAYMENTS.includes(v) ? v : 'Cash'; }
  catch (_) { return 'Cash'; }
}

// Pure price-chip math (exported for tests via window): whole dollars.
function smChipPrice(asking, chip, other) {
  const a = Number(asking) || 0;
  if (chip === 'asking') return Math.round(a);
  if (chip === 'minus5') return Math.round(a * 0.95);
  if (chip === 'minus10') return Math.round(a * 0.90);
  const o = parseFloat(String(other || '').replace(/[^0-9.]/g, ''));
  return isNaN(o) ? 0 : Math.round(o * 100) / 100;
}

function _smDraftAsking(d) {
  const card = _smDraftCard(d);
  if (card) return Number(card.Price) || 0;
  return Number(d.newItem && d.newItem.asking) || 0;
}

function smRenderConfirm() {
  const d = _smLoadDraft();
  const card = _smDraftCard(d);
  if (!d || (!card && !d.newItem)) { smGo('/sell', true); return; }
  if (card && card.Status === 'Sold') { showToast('That card is already sold', 'gold'); smGo('', true); return; }
  const manual = d.mode === 'manual';
  const asking = _smDraftAsking(d);
  if (!asking && d.chip !== 'other') d.chip = 'other';
  const capThumb = d.captureId && _smThumbUrls.get(d.captureId);
  const thumb = capThumb ? `<img class="sm-thumb" src="${smEsc(capThumb)}" alt="">` : (card ? _smCardThumb(card) : '<div class="sm-thumb" aria-hidden="true"></div>');
  const n = d.newItem || {};
  const name = card ? (card.Player || card['Card Title']) : (n.player || 'New card');
  const meta = card
    ? [card['Set '], _smCardNum(card.Number), _smGradeLabel(card)].filter(Boolean).join(' · ')
    : [n.cardSet, _smCardNum(n.number), n.grader ? `${n.grader} ${n.grade}`.trim() : 'Raw'].filter(Boolean).join(' · ');
  const graderOpts = ['', ...(typeof VALID_GRADERS !== 'undefined' ? VALID_GRADERS : ['PSA', 'BGS', 'CGC', 'SGC'])];
  const details = card ? '' : `
    <details class="sm-details" ${n.player ? '' : 'open'}>
      <summary>Card details</summary>
      <div class="sm-form">
        ${_smField('Player', 'smNPlayer', n.player)}
        <div class="sm-form-row">${_smField('Year', 'smNYear', n.year, 'numeric')}${_smField('Card #', 'smNNumber', n.number)}</div>
        ${_smField('Set', 'smNSet', n.cardSet)}
        ${_smField('Parallel', 'smNParallel', n.parallel)}
        <div class="sm-form-row">
          <label class="sm-field"><span>Grader</span>
            <select id="smNGrader" onchange="smDraftInput()">${graderOpts.map(g => `<option value="${smEsc(g)}" ${String(n.grader || '') === g ? 'selected' : ''}>${g || 'Raw'}</option>`).join('')}
              ${n.grader && !graderOpts.includes(n.grader) ? `<option value="${smEsc(n.grader)}" selected>${smEsc(n.grader)}</option>` : ''}</select></label>
          ${_smField('Grade', 'smNGrade', n.grade, 'decimal')}
        </div>
        ${_smField('Cert #', 'smNCert', n.cert)}
        ${_smField('Asking price', 'smNAsking', n.asking, 'decimal')}
      </div>
    </details>`;

  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="history.back()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">${manual ? 'Log sale' : 'Confirm sale'}</div>
      <span style="width:44px"></span>
    </div>
    <div class="sm-row">
      ${thumb}
      <div class="sm-row-body">
        <div class="sm-row-title" id="smConfirmName">${smEsc(name)}</div>
        <div class="sm-row-meta">${smEsc(meta)}</div>
      </div>
      <div class="sm-market"><span>Market</span><strong id="smConfirmMarket">…</strong></div>
    </div>
    ${details}
    <div class="sm-section-label" style="margin-top:18px">Sold for</div>
    <div class="sm-hero-price" id="smHeroPrice" aria-live="polite"></div>
    <div class="sm-chip-grid" role="group" aria-label="Price">
      ${[['asking', 'Asking'], ['minus5', '−5%'], ['minus10', '−10%'], ['other', 'Other']].map(([k, label]) =>
        `<button class="sm-chip sm-chip--big" data-chip="${k}" aria-pressed="${d.chip === k}" ${k !== 'other' && !asking ? 'disabled' : ''} onclick="smSetChip('${k}')">${label}</button>`).join('')}
    </div>
    <div id="smOtherWrap" style="display:${d.chip === 'other' ? '' : 'none'}">
      <label class="sm-field"><span>Sale price</span>
        <input id="smOtherPrice" inputmode="decimal" autocomplete="off" placeholder="0" value="${smEsc(d.otherPrice)}" oninput="smDraftInput()"></label>
    </div>
    <div class="sm-section-label" style="margin-top:18px">Paid with</div>
    <div class="sm-chip-grid sm-chip-grid--3" role="group" aria-label="Payment method">
      ${SM_PAYMENTS.map(p => `<button class="sm-chip sm-chip--big" data-pay="${p}" aria-pressed="${d.payment === p}" onclick="smSetPayment('${p}')">${p}</button>`).join('')}
    </div>
    <div id="smBuyerWrap">${d.buyerHandle ? '' : '<button class="sm-link sm-link--dark" onclick="smShowBuyerField()">Add buyer\'s IG handle</button>'}</div>
    <div id="smBuyerField" style="display:${d.buyerHandle ? '' : 'none'}">${_smField('Buyer\'s Instagram', 'smBuyer', d.buyerHandle)}</div>
    <button class="sm-confirm-btn" id="smConfirmBtn" onclick="smMarkSold()"></button>
    <p class="sm-helper">${manual ? 'Logs the sale on this show. You can undo.' : 'Removes it from your live show page instantly. You can undo.'}</p>`;
  _smUpdatePrice();
  _smFillMarket(card || _smFieldsToCard(n), 'smConfirmMarket').then(v => {
    if (!card && v && !d.newItem.asking) {
      d.newItem.asking = String(Math.round(v));
      const a = document.getElementById('smNAsking');
      if (a && !a.value) a.value = d.newItem.asking;
      _smSaveDraft();
      _smEnableChips();
      if (d.chip === 'other' && !d.otherPrice && _smScreen === 'confirm') smSetChip('asking');
    }
  });
}

function _smField(label, id, value, inputmode) {
  return `<label class="sm-field"><span>${label}</span><input id="${id}" ${inputmode ? `inputmode="${inputmode}"` : ''} autocomplete="off" value="${smEsc(value)}" oninput="smDraftInput()"></label>`;
}

function _smEnableChips() {
  const asking = _smDraftAsking(_smDraft);
  document.querySelectorAll('[data-chip]').forEach(b => { if (b.dataset.chip !== 'other') b.disabled = !asking; });
}

function smDraftInput() {
  const d = _smDraft;
  if (!d) return;
  const v = id => (document.getElementById(id)?.value ?? '').trim();
  if (d.newItem) {
    Object.assign(d.newItem, {
      player: v('smNPlayer'), year: v('smNYear'), number: v('smNNumber'), cardSet: v('smNSet'),
      parallel: v('smNParallel'), grader: v('smNGrader'), grade: v('smNGrade'), cert: v('smNCert'), asking: v('smNAsking'),
    });
    const nameEl = document.getElementById('smConfirmName');
    if (nameEl) nameEl.textContent = d.newItem.player || 'New card';
    _smEnableChips();
  }
  d.otherPrice = v('smOtherPrice');
  d.buyerHandle = v('smBuyer');
  _smSaveDraft();
  _smUpdatePrice();
}

function smSetChip(k) {
  _smDraft.chip = k;
  document.querySelectorAll('[data-chip]').forEach(b => b.setAttribute('aria-pressed', b.dataset.chip === k));
  document.getElementById('smOtherWrap').style.display = k === 'other' ? '' : 'none';
  if (k === 'other') setTimeout(() => document.getElementById('smOtherPrice')?.focus(), 30);
  _smSaveDraft();
  _smUpdatePrice();
}
function smSetPayment(p) {
  _smDraft.payment = p;
  document.querySelectorAll('[data-pay]').forEach(b => b.setAttribute('aria-pressed', b.dataset.pay === p));
  _smSaveDraft();
}
function smShowBuyerField() {
  document.getElementById('smBuyerWrap').innerHTML = '';
  document.getElementById('smBuyerField').style.display = '';
  document.getElementById('smBuyer')?.focus();
}

function _smDraftPrice() {
  const d = _smDraft;
  return smChipPrice(_smDraftAsking(d), d.chip, d.otherPrice);
}
function _smUpdatePrice() {
  const price = _smDraftPrice();
  const hero = document.getElementById('smHeroPrice');
  if (hero) hero.textContent = _smMoney(price);
  const btn = document.getElementById('smConfirmBtn');
  if (btn) {
    btn.innerHTML = `${_smIcon('check')} ${_smDraft.mode === 'manual' ? 'Log sale' : 'Mark sold'} · ${_smMoney(price)}`;
    btn.disabled = !(price > 0);
  }
}

// Builds a classic inventory card from the confirm screen's details.
function _smCardFromNewItem(n) {
  const raw = {
    Seller: currentSeller,
    Player: n.player || '', Year: n.year || '', 'Set ': n.cardSet || '', Number: n.number || '',
    'Parallel/Variant': n.parallel || '', Grader: n.grader || '', Grade: n.grade || '',
    'Cert #': n.grader ? (n.cert || null) : null, Price: parseFloat(n.asking) || 0,
    Status: 'Available', Location: null, item_type: 'card',
  };
  raw['Card Title'] = buildCardTitle({ player: raw.Player, year: raw.Year, cardSet: raw['Set '], cardNum: raw.Number, parallel: raw['Parallel/Variant'], sport: '', rawTitle: '' })
    || [raw.Year, raw['Set '], raw.Player].filter(Boolean).join(' ');
  const card = validateAndNormalizeCard(raw);
  card.Seller = currentSeller;
  return card;
}

// ════════════════════════════════════════════════════════════════════════════
// Mark sold (optimistic) and undo
// ════════════════════════════════════════════════════════════════════════════
let _smLastSaleId = null;

async function smMarkSold() {
  const d = _smDraft;
  if (!d) return;
  smDraftInput();
  const price = _smDraftPrice();
  if (!(price > 0)) { showToast('Enter the sale price', 'var(--danger)'); return; }
  let card = _smDraftCard(d);
  const isNew = !card;
  if (isNew && !d.newItem.player) {
    showToast('Add the player or card name', 'var(--danger)');
    const det = document.querySelector('.sm-details'); if (det) det.open = true;
    document.getElementById('smNPlayer')?.focus();
    return;
  }
  if (card && !card._dbId) { showToast('This card hasn\'t synced yet — try again in a moment', 'gold'); return; }
  if (card && card.Status === 'Sold') { showToast('That card is already sold', 'gold'); return; }

  const clientSaleId = _smUuid();
  const now = new Date();
  const soldTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const soldDate = _todayISO();
  const source = d.mode === 'manual' ? 'manual_sale' : 'show_mode';
  const prevSnapshot = card ? { price: card.Price } : null;

  if (isNew) {
    card = _smCardFromNewItem(d.newItem);
    card._dbId = _smUuid();
    if (source === 'manual_sale') card._manualSale = true;
    inventory.push(card);
  }
  card.Status = 'Sold';
  card.SoldPrice = price;
  card.PaymentMethod = d.payment;
  card.SoldTime = soldTime;
  card.SoldDate = soldDate;
  card._clientSaleId = clientSaleId;
  card._saleAt = now.getTime();
  card._smPending = true;
  if (d.captureId) { card._captureId = d.captureId; _smCaptureIndex.set(card._dbId, d.captureId); }
  if (!(card._shows instanceof Set)) card._shows = new Set();
  card._shows.add(_smShowId);

  const newItem = isNew ? Object.assign({}, cardToDbRow(card), { id: card._dbId }) : null;
  if (newItem) { delete newItem.status; }
  const snapshot = _smSnapshot(card);
  await smEnqueue({
    type: 'sale', clientSaleId, cardSnapshot: snapshot,
    payload: {
      inventoryId: isNew ? null : card._dbId, newItem, showId: _smShowId, price, payment: d.payment,
      buyerHandle: d.buyerHandle || '', soldDate, soldTime, captureId: d.captureId || null, source,
    },
  });
  if (d.captureId) {
    smUpdateCapture(d.captureId, { attachedTo: card._dbId });
    _smLogEvent('capture_attached', { entryPoint: source === 'manual_sale' ? 'manual_sale' : 'sell_card', attachType: source === 'manual_sale' ? 'manual_sale' : (isNew ? 'new_item' : 'existing_item') });
  }
  try { localStorage.setItem(_smLastPaymentKey(), d.payment); } catch (_) {}

  _smLastSaleId = clientSaleId;
  const values = { mode: d.mode, chip: d.chip, otherPrice: d.otherPrice, payment: d.payment, buyerHandle: d.buyerHandle, captureId: d.captureId, prevSnapshot };
  try { sessionStorage.setItem('smLastSale', JSON.stringify({ clientSaleId, itemKey: card._dbId, values })); } catch (_) {}
  _smDraft = null;
  _smSaveDraft();

  _smLogEvent(source === 'manual_sale' ? 'manual_sale_logged' : 'sale_confirmed', {
    priceChip: d.chip, paymentMethod: d.payment, msFromSellStart: _smSellStartedAt ? Date.now() - _smSellStartedAt : null,
    msFromStart: _smSellStartedAt ? Date.now() - _smSellStartedAt : null, queuedOffline: !navigator.onLine, newItem: isNew,
  });
  _smAfterInventoryChange();
  if (navigator.vibrate) navigator.vibrate(30);
  smGo('/sold/' + clientSaleId, true);
}

function _smSnapshot(card) {
  const s = {};
  Object.keys(card).forEach(k => { if (!(card[k] instanceof Set) && typeof card[k] !== 'function') s[k] = card[k]; });
  return s;
}

async function smUndoSale(clientSaleId, opts) {
  const card = _smFindCardBySale(clientSaleId);
  if (!card) return;
  const savedAt = card._saleAt;
  let pending = null;
  try {
    pending = (await smStore.all('outbox')).find(o => o.type === 'sale' && o.clientSaleId === clientSaleId) || null;
  } catch (_) {}
  _smClearSold(card);
  card._clientSaleId = null;
  card._smPending = false;
  if (pending && !_smDraining) {
    // Never reached the server: cancel it. A card created by Add & sell or a
    // manual sale still goes into the case (with its photo), as Available.
    await smStore.del('outbox', pending.seq);
    if (pending.payload.newItem) {
      card._smPending = true;
      await smEnqueue({ type: 'add_item', inventoryId: card._dbId, cardSnapshot: _smSnapshot(card), captureId: pending.payload.captureId, showId: pending.payload.showId, source: pending.payload.source });
    }
  } else {
    await smEnqueue({ type: 'void', clientSaleId, inventoryId: card._dbId });
  }
  _smLogEvent('sale_undone', { secondsAfterSale: savedAt ? Math.round((Date.now() - savedAt) / 1000) : null });
  _smAfterInventoryChange();
  smHideToast();
  if (opts && opts.returnToConfirm) {
    let last = null;
    try { last = JSON.parse(sessionStorage.getItem('smLastSale') || 'null'); } catch (_) {}
    const v = (last && last.clientSaleId === clientSaleId) ? last.values : {};
    _smDraft = {
      showId: _smShowId, mode: v.mode || 'sell', itemKey: card._dbId, newItem: null, captureId: v.captureId || null,
      chip: v.chip || 'asking', otherPrice: v.otherPrice || '', payment: v.payment || _smLastPayment(), buyerHandle: v.buyerHandle || '',
    };
    _smSaveDraft();
    smGo('/confirm', true);
  } else {
    showToast('Sale undone — the card is back in your case');
    smRefresh();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Screen 4: Sold
// ════════════════════════════════════════════════════════════════════════════
let _smToastTimer = null;
function smHideToast() {
  clearInterval(_smToastTimer);
  _smToastTimer = null;
  const t = document.getElementById('smUndoToast');
  if (t) t.remove();
}

function smRenderSold(clientSaleId) {
  const id = clientSaleId || _smLastSaleId;
  let card = id ? _smFindCardBySale(id) : null;
  if (!card) {
    try {
      const last = JSON.parse(sessionStorage.getItem('smLastSale') || 'null');
      if (last && last.clientSaleId === id) card = inventory.find(c => c._dbId === last.itemKey) || null;
    } catch (_) {}
  }
  if (!card || card.Status !== 'Sold') { smGo('', true); return; }
  const today = _todayISO();
  const soldToday = getSellerInventory().filter(r => r.Status === 'Sold' && r.SoldDate === today);
  const total = soldToday.reduce((s, r) => s + (Number(r.SoldPrice) || 0), 0);
  const fresh = !document.getElementById('smSoldScreen');
  _smView().innerHTML = `
    <div class="sm-sold" id="smSoldScreen">
      <div class="sm-confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <div class="sm-sold-check">${_smIcon('check')}</div>
      <h1 class="sm-sold-title">Sold!</h1>
      <div class="sm-sold-detail">${smEsc(card.Player || card['Card Title'] || 'Card')} · ${_smMoney(card.SoldPrice)} · ${smEsc(card.PaymentMethod)}</div>
      <div class="sm-sold-sub">That's sale #${soldToday.length} today. ${_smMoney(total)} total.${card._smPending ? ' <span class="sm-sync sm-sync--dark">Syncing</span>' : ''}</div>
      <button class="sm-primary sm-primary--ink" onclick="smStartSell('sold_next')">Sell next card</button>
      <div class="sm-sold-actions">
        <button class="sm-sec-btn" onclick="smShareSale('${smEsc(card._clientSaleId || id)}')">${_smIcon('share')}Share sale</button>
        <button class="sm-sec-btn" onclick="smGoHome()">Back to show</button>
      </div>
    </div>`;
  if (fresh && card._saleAt && Date.now() - card._saleAt < SM_UNDO_TOAST_MS + 1000) _smShowUndoToast(card._clientSaleId);
}

function _smShowUndoToast(clientSaleId) {
  smHideToast();
  const t = document.createElement('div');
  t.id = 'smUndoToast';
  t.className = 'sm-toast';
  t.innerHTML = `<span>Removed from your show page</span>
    <button class="sm-toast-btn" onclick="smUndoSale('${smEsc(clientSaleId)}', { returnToConfirm: true })">Undo <span id="smUndoCount">5</span></button>`;
  document.getElementById('showModeRoot').appendChild(t);
  const end = Date.now() + SM_UNDO_TOAST_MS;
  _smToastTimer = setInterval(() => {
    const left = Math.ceil((end - Date.now()) / 1000);
    const c = document.getElementById('smUndoCount');
    if (left <= 0) { smHideToast(); return; }
    if (c) c.textContent = left;
  }, 250);
}

// Share sale reuses "The Drop" share card, with the scan as its photo.
async function smShareSale(clientSaleId) {
  const card = _smFindCardBySale(clientSaleId);
  if (!card) return;
  const capId = card._captureId || _smCaptureIndex.get(card._dbId);
  if (capId && !card._dropPhotoDataUrl) {
    const cap = await smStore.get('captures', capId).catch(() => null);
    if (cap && cap.crop) card._dropPhotoDataUrl = await _smBlobToDataUrl(cap.crop);
  }
  openShareCardModal(card, _smShowId);
}

// ════════════════════════════════════════════════════════════════════════════
// Screen 5: inventory
// ════════════════════════════════════════════════════════════════════════════
let _smInvTab = 'case';
let _smInvLimit = SM_INVENTORY_PAGE;

function smRenderInventory() {
  _smInvLimit = SM_INVENTORY_PAGE;
  const mine = getSellerInventory();
  const sold = mine.filter(r => r.Status === 'Sold').length;
  _smView().innerHTML = `
    ${_smHeaderHTML()}
    <h1 class="sm-title sm-title--page">Inventory</h1>
    <div class="sm-row-meta" style="margin:-4px 0 12px">${mine.length - sold} in case · ${sold} sold</div>
    <label class="sm-sr-only" for="smInvSearch">Search inventory</label>
    <div class="sm-search sm-search--light">${_smIcon('search')}<input id="smInvSearch" type="search" autocomplete="off"
      placeholder="Search your inventory" oninput="_smInvLimit=${SM_INVENTORY_PAGE};smRenderInventoryList()"></div>
    <div class="sm-tabs" role="tablist" aria-label="Inventory">
      ${[['case', 'In case'], ['sold', 'Sold'], ['all', 'All']].map(([k, l]) =>
        `<button role="tab" aria-selected="${_smInvTab === k}" onclick="smSetInvTab('${k}')">${l}</button>`).join('')}
    </div>
    <div class="sm-list" id="smInvList"></div>`;
  smRenderInventoryList();
}
function smSetInvTab(k) {
  _smInvTab = k;
  _smInvLimit = SM_INVENTORY_PAGE;
  document.querySelectorAll('.sm-tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', b.getAttribute('onclick').includes(`'${k}'`)));
  smRenderInventoryList();
}

function smRenderInventoryList() {
  const box = document.getElementById('smInvList');
  if (!box) return;
  const q = (document.getElementById('smInvSearch')?.value || '').toLowerCase().split(/\s+/).filter(Boolean);
  let rows = getSellerInventory().filter(r =>
    _smInvTab === 'all' ? true : _smInvTab === 'sold' ? r.Status === 'Sold' : r.Status !== 'Sold');
  if (q.length) rows = rows.filter(r => {
    const hay = [r['Card Title'], r.Player, r.Year, r['Set '], r.Number, r['Parallel/Variant'], r.Grader, r.Grade, r['Cert #']]
      .map(v => String(v ?? '').toLowerCase()).join(' ');
    return q.every(w => hay.includes(w));
  });
  if (_smInvTab === 'sold') rows.sort((a, b) => (_smSaleTime(b) || 0) - (_smSaleTime(a) || 0));
  // Long lists render in pages so a 1,000-card case stays fast on a phone.
  const shown = rows.slice(0, _smInvLimit);
  box.innerHTML = shown.length ? shown.map(r => {
    const sold = r.Status === 'Sold';
    const action = sold
      ? '<span class="sm-badge sm-badge--ok">Sold</span>'
      : `<button class="sm-row-btn" onclick="smPickCard('${smEsc(r._dbId || '')}', 'inventory_row')">Sell</button>`;
    return `<div class="sm-row ${sold ? 'sm-row--sold' : ''}">
      ${_smCardThumb(r)}
      <div class="sm-row-body">
        <div class="sm-row-title">${smEsc(r.Player || r['Card Title'] || 'Card')}</div>
        <div class="sm-row-meta">${smEsc([r['Set '], _smGradeLabel(r)].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="sm-row-price">${_smMoney(sold ? r.SoldPrice : r.Price)}</div>
      ${action}
    </div>`;
  }).join('') + (rows.length > shown.length
    ? `<button class="sm-sec-btn" onclick="_smInvLimit+=${SM_INVENTORY_PAGE};smRenderInventoryList()">Show ${Math.min(SM_INVENTORY_PAGE, rows.length - shown.length)} more</button>` : '')
    : '<div class="sm-empty">Nothing here yet.</div>';
}

// ════════════════════════════════════════════════════════════════════════════
// Recent scans: captures that never became a sale or an inventory item.
// ════════════════════════════════════════════════════════════════════════════
async function smRenderScans() {
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="history.back()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Recent scans</div>
      <span style="width:44px"></span>
    </div>
    <div class="sm-list" id="smScansList"><div class="sm-empty">Loading…</div></div>`;
  const local = (await smStore.all('captures').catch(() => []))
    .filter(c => c.seller === currentSeller && !c.deleted && !c.attachedTo);
  const items = local.map(c => ({ id: c.id, createdAt: c.createdAt, ident: c.identification, thumb: smThumbUrl(c.id, c.crop) }));
  if (navigator.onLine && !_smCapturesMissing && typeof db !== 'undefined') {
    const { data, error } = await db.from('card_captures').select('id, created_at, identification, crop_key')
      .eq('status', 'unattached').is('deleted_at', null).order('created_at', { ascending: false }).limit(50);
    if (!error && data) {
      const have = new Set(items.map(i => i.id));
      for (const row of data) {
        if (have.has(row.id)) continue;
        let thumb = null;
        if (row.crop_key) {
          const s = await db.storage.from('card-captures').createSignedUrl(row.crop_key, 3600);
          thumb = s.data && s.data.signedUrl;
        }
        items.push({ id: row.id, createdAt: Date.parse(row.created_at), ident: row.identification, thumb, remote: true });
      }
    } else if (error && _smIsMissingTable({ error })) {
      _smCapturesMissing = true;
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  const box = document.getElementById('smScansList');
  if (!box) return;
  box.innerHTML = items.length ? items.map(i => {
    const f = i.ident && i.ident.fields;
    return `<div class="sm-scan-row">
      <div class="sm-row">
        ${i.thumb ? `<img class="sm-thumb" src="${smEsc(i.thumb)}" alt="">` : '<div class="sm-thumb" aria-hidden="true"></div>'}
        <div class="sm-row-body">
          <div class="sm-row-title">${smEsc(f ? (f.player || 'Unknown card') : 'Not identified')}</div>
          <div class="sm-row-meta">${smEsc([f && f.year, f && f.cardSet, _smRelTime(new Date(i.createdAt))].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
      <div class="sm-scan-actions">
        <button class="sm-row-btn" onclick="smScanSell('${i.id}')">Sell</button>
        <button class="sm-row-btn sm-row-btn--ghost" onclick="smScanAddToCase('${i.id}')">Add to case</button>
        <button class="sm-row-btn sm-row-btn--ghost" onclick="smScanDelete('${i.id}')" aria-label="Delete scan">Delete</button>
      </div>
    </div>`;
  }).join('') : '<div class="sm-empty">No unsold scans. Every card you scan is kept here until it\'s sold or added.</div>';
  _smScanItems = items;
}
let _smScanItems = [];

function _smScanFields(id) {
  const it = _smScanItems.find(i => i.id === id);
  return (it && it.ident && it.ident.fields) || {};
}

function smScanSell(id) {
  const f = _smScanFields(id);
  const match = f.player ? smMatchInventory(f)[0] : null;
  if (match) return smPickCard(match.card._dbId, 'scan', id);
  _smDraft = {
    showId: _smShowId, mode: 'sell', itemKey: null,
    newItem: { player: f.player || '', year: f.year || '', cardSet: f.cardSet || '', number: f.number || '', parallel: f.parallel || '', grader: f.grader || '', grade: f.grade || '', cert: f.cert || '', asking: '' },
    captureId: id, chip: 'other', otherPrice: '', payment: _smLastPayment(), buyerHandle: '',
  };
  _smSaveDraft();
  smGo('/confirm');
}

async function smScanAddToCase(id) {
  const f = _smScanFields(id);
  const askingRaw = prompt('Asking price for this card?', '');
  if (askingRaw === null) return;
  const card = _smCardFromNewItem({ player: f.player || 'Unknown card', year: f.year, cardSet: f.cardSet, number: f.number, parallel: f.parallel, grader: f.grader, grade: f.grade, cert: f.cert, asking: askingRaw });
  card._dbId = _smUuid();
  card._captureId = id;
  card._smPending = true;
  inventory.push(card);
  _smCaptureIndex.set(card._dbId, id);
  await smUpdateCapture(id, { attachedTo: card._dbId });
  await smEnqueue({ type: 'add_item', inventoryId: card._dbId, cardSnapshot: _smSnapshot(card), captureId: id, showId: _smShowId, source: 'show_mode' });
  _smLogEvent('capture_attached', { entryPoint: 'sell_card', attachType: 'new_item' });
  _smAfterInventoryChange();
  showToast(`✓ ${card.Player} added to your case`);
  smRenderScans();
}

async function smScanDelete(id) {
  if (!confirm('Delete this scan? Its photos are removed.')) return;
  await smUpdateCapture(id, { deleted: true, crop: null, original: null, back: null }, { deleted_at: new Date().toISOString() });
  const url = _smThumbUrls.get(id);
  if (url) { URL.revokeObjectURL(url); _smThumbUrls.delete(id); }
  smRenderScans();
}

// ════════════════════════════════════════════════════════════════════════════
// Add cards: a choice sheet (one card / whole case / type it in / spreadsheet),
// the one-card camera (/addone) and the Type it in form (/addtype). Adds go
// through the same add_item outbox op as Recent scans → Add to case.
// ════════════════════════════════════════════════════════════════════════════
let _smAddedCount = 0;   // cards added on this visit to the one-card camera

function smOpenAddSheet() { document.getElementById('smAddBackdrop')?.classList.add('open'); }
function smCloseAddSheet() { document.getElementById('smAddBackdrop')?.classList.remove('open'); }

// File pickers must open inside the tap, so the upload click comes before
// anything else.
function smAddChoose(kind) {
  if (kind === 'upload') {
    const input = document.querySelector('#uploadZone input[type="file"]');
    if (input) input.click(); else showToast('Spreadsheet upload isn\'t available here', 'gold');
    smCloseAddSheet();
    return;
  }
  smCloseAddSheet();
  if (kind === 'one') { _smAddedCount = 0; smGo('/addone'); }
  else if (kind === 'case') smGo('/add/scan');
  else if (kind === 'type') smStartAddType();
}

function _smAddFields(r) { return r.addFields || r.ident.fields; }

function _smRenderAddResult() {
  const sheet = document.getElementById('smResultSheet');
  const r = _smLastResult;
  const thumb = _smThumbUrls.get(r.capture.id);
  const img = `<img class="sm-result-img" src="${smEsc(thumb || '')}" alt="">`;
  if (!r.ident.fields) {
    sheet.innerHTML = `
      <div class="sm-sheet-card">
        <div class="sm-result-top"><span class="sm-saved">${_smIcon('check')}Photo saved</span></div>
        <div class="sm-result-main">${img}
          <div><div class="sm-result-name">${r.ident.offline ? 'No signal — can\'t identify right now' : 'Couldn\'t read this card'}</div>
          <div class="sm-row-meta">Try again, or type the details in.</div></div>
        </div>
        <button class="sm-primary" onclick="smRetryScan()">Try again</button>
        <div class="sm-links"><button class="sm-link" onclick="smStartAddType(true)">Type it in</button></div>
      </div>`;
    _smAnnounce('Could not identify the card.');
    return;
  }
  const f = _smAddFields(r);
  const match = !r.forceNew && r.matches[0] && r.matches[0].card;
  const meta = [f.year, f.cardSet, _smCardNum(f.number), f.grader ? `${f.grader} ${f.grade}`.trim() : 'Raw'].filter(Boolean).join(' · ');
  if (match) {
    sheet.innerHTML = `
      <div class="sm-sheet-card">
        <div class="sm-result-top">
          <span class="sm-badge sm-badge--warn">Already in your case</span>
          <span class="sm-saved">${_smIcon('check')}Photo saved</span>
        </div>
        <div class="sm-result-main">${img}
          <div><div class="sm-result-name">${smEsc(match.Player || match['Card Title'] || 'Card')}</div>
          <div class="sm-row-meta">${smEsc([match.Year, match['Set '], _smCardNum(match.Number), _smGradeLabel(match)].filter(Boolean).join(' · '))}</div>
          <div class="sm-row-meta">Your price ${_smMoney(match.Price)}</div></div>
        </div>
        <button class="sm-primary" onclick="smAddScanNext()">Scan next card</button>
        <div class="sm-links">
          <button class="sm-link" onclick="smAddAnotherCopy()">Add another copy</button>
          <button class="sm-link" onclick="smStartAddType(true)">It's a different card</button>
        </div>
      </div>`;
    _smAnnounce('Already in your case: ' + (match.Player || 'card'));
    return;
  }
  const cands = r.ident.candidates || [];
  sheet.innerHTML = `
    <div class="sm-sheet-card">
      <div class="sm-result-top">
        <span class="sm-badge sm-badge--ok">New card</span>
        <span class="sm-saved">${_smIcon('check')}Photo saved</span>
      </div>
      <div class="sm-result-main">${img}
        <div><div class="sm-result-name">${smEsc(f.player || f.cardSet || 'Unknown card')}</div>
        <div class="sm-row-meta">${smEsc(meta)}</div>
        <div class="sm-row-meta">Market <span id="smResultMarket">…</span></div></div>
      </div>
      <label class="sm-field">Your price
        <input id="smAddPrice" type="text" inputmode="decimal" placeholder="0" autocomplete="off"
          oninput="this.dataset.edited='1'">
      </label>
      <button class="sm-primary" id="smAddBtn" onclick="smAddToCase()">Add to case · live now</button>
      <div class="sm-links">
        ${cands.length ? '<button class="sm-link" onclick="smAddShowCandidates()">Wrong card?</button>' : ''}
        <button class="sm-link" onclick="smStartAddType(true)">Edit details</button>
        <button class="sm-link" onclick="smAddBackPhoto()">Add back photo</button>
      </div>
      <div id="smCandidates"></div>
    </div>`;
  _smAnnounce('New card: ' + (f.player || 'card'));
  const capId = r.capture.id;
  _smFillMarket(_smFieldsToCard(f), 'smResultMarket').then(v => {
    const input = document.getElementById('smAddPrice');
    if (v && input && !input.dataset.edited && _smLastResult && _smLastResult.capture.id === capId) input.value = String(Math.round(v));
  });
}

function smAddShowCandidates() {
  const r = _smLastResult, box = document.getElementById('smCandidates');
  if (!r || !box) return;
  box.innerHTML = `<div class="sm-section-label" style="margin-top:12px">Other matches</div><div class="sm-list">${
    r.ident.candidates.map((c, i) => `
      <button class="sm-row sm-row--button" onclick="smAddUseCandidate(${i})">
        <span class="sm-row-body"><span class="sm-row-title">${smEsc(c.player || 'Unknown')}</span>
        <span class="sm-row-meta">${smEsc([c.year, c.cardSet, _smCardNum(c.number), c.parallel].filter(Boolean).join(' · '))}</span></span>
      </button>`).join('')}</div>`;
}

function smAddUseCandidate(i) {
  const r = _smLastResult;
  const c = r && r.ident.candidates[i];
  if (!c) return;
  const base = r.ident.fields || {};
  r.addFields = Object.assign({}, base, c, { grader: c.grader || base.grader || '', grade: c.grade || base.grade || '', cert: c.cert || base.cert || '' });
  ['source', 'confidence', 'catalogCardId'].forEach(k => delete r.addFields[k]);
  r.matches = smMatchInventory(r.addFields);
  _smRenderAddResult();
}

function smAddAnotherCopy() {
  if (!_smLastResult) return;
  _smLastResult.forceNew = true;
  _smRenderAddResult();
}

function smAddScanNext() {
  _smLastResult = null;
  const sheet = document.getElementById('smResultSheet');
  if (sheet) sheet.innerHTML = '';
  const shutter = document.getElementById('smShutter');
  if (shutter) shutter.disabled = false;
  const t = document.querySelector('.sm-sell-title');
  if (t) t.innerHTML = 'Add a card' + (_smAddedCount ? ` <span class="sm-added-count">${_smAddedCount} added</span>` : '');
}

// A new inventory card from identification fields, queued like every other
// Show Mode add, published to the show, with the capture as its photo.
async function _smAddNewCard(f, price, captureId) {
  const card = _smCardFromNewItem({
    player: f.player || 'Unknown card', year: f.year, cardSet: f.cardSet, number: f.number, parallel: f.parallel,
    grader: f.grader, grade: f.grade, cert: f.cert, asking: price,
  });
  card._dbId = _smUuid();
  card._smPending = true;
  if (captureId) { card._captureId = captureId; _smCaptureIndex.set(card._dbId, captureId); }
  inventory.push(card);
  if (captureId) await smUpdateCapture(captureId, { attachedTo: card._dbId });
  await smEnqueue({ type: 'add_item', inventoryId: card._dbId, cardSnapshot: _smSnapshot(card), captureId: captureId || null, showId: _smShowId, source: 'show_mode' });
  if (captureId) _smLogEvent('capture_attached', { entryPoint: 'add_card', attachType: 'new_item' });
  _smLogEvent('card_added', { via: captureId ? 'scan' : 'typed' });
  _smAfterInventoryChange();
  return card;
}

function _smPriceValue(id) { return String(document.getElementById(id)?.value || '').replace(/[^0-9.]/g, ''); }

async function smAddToCase() {
  const r = _smLastResult;
  if (!r || !r.ident.fields) return;
  const btn = document.getElementById('smAddBtn');
  if (btn) btn.disabled = true;
  const card = await _smAddNewCard(_smAddFields(r), _smPriceValue('smAddPrice'), r.capture.id);
  _smAddedCount++;
  showToast(`✓ ${card.Player} added to your case`);
  smAddScanNext();
}

// ── Type it in (/addtype) ──
function smStartAddType(fromScan) {
  const r = fromScan && _smLastResult;
  const f = r && r.ident.fields ? _smAddFields(r) : {};
  const draft = { fields: Object.assign({ player: '', year: '', cardSet: '', number: '', parallel: '', grader: '', grade: '', cert: '' }, f), captureId: r ? r.capture.id : null, price: _smPriceValue('smAddPrice') };
  try { sessionStorage.setItem('smAddDraft', JSON.stringify(draft)); } catch (_) {}
  smGo('/addtype');
}

function smRenderAddType() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem('smAddDraft') || 'null'); } catch (_) {}
  d = d || { fields: {}, captureId: null, price: '' };
  const f = d.fields || {};
  const thumb = d.captureId && _smThumbUrls.get(d.captureId);
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="history.back()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Add a card</div>
      <span style="width:44px"></span>
    </div>
    ${thumb ? `<div class="sm-result-main" style="margin-bottom:6px"><img class="sm-result-img" src="${smEsc(thumb)}" alt=""><div class="sm-row-meta">Your photo is saved with this card.</div></div>` : ''}
    <div class="sm-form-row">${_smField('Player or character', 'smAT_player', f.player)}</div>
    <div class="sm-form-row">${_smField('Year', 'smAT_year', f.year, 'numeric')}${_smField('Card #', 'smAT_number', f.number)}</div>
    <div class="sm-form-row">${_smField('Set', 'smAT_cardSet', f.cardSet)}</div>
    <div class="sm-form-row">${_smField('Parallel', 'smAT_parallel', f.parallel)}</div>
    <div class="sm-form-row">${_smField('Grader', 'smAT_grader', f.grader)}${_smField('Grade', 'smAT_grade', f.grade, 'decimal')}${_smField('Cert #', 'smAT_cert', f.cert, 'numeric')}</div>
    <div class="sm-form-row">${_smField('Your price', 'smAT_price', d.price, 'decimal')}</div>
    <button class="sm-primary" id="smATBtn" onclick="smAddTypeSubmit()">Add to case · live now</button>
    <div class="sm-links"><button class="sm-link" onclick="smGoHome()">Done</button></div>`;
  if (!f.player) setTimeout(() => document.getElementById('smAT_player')?.focus(), 50);
}

async function smAddTypeSubmit() {
  const v = k => (document.getElementById('smAT_' + k)?.value || '').trim();
  const f = { player: v('player'), year: v('year'), cardSet: v('cardSet'), number: v('number'), parallel: v('parallel'),
    grader: _smNormGrader(v('grader')), grade: v('grade'), cert: v('cert') };
  if (!f.player && !f.cardSet) { showToast('Add at least the player or the set', 'gold'); document.getElementById('smAT_player')?.focus(); return; }
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem('smAddDraft') || 'null'); } catch (_) {}
  const captureId = d && d.captureId;
  if (captureId) {
    const cap = await smStore.get('captures', captureId).catch(() => null);
    if (cap && cap.attachedTo) { showToast('That photo is already on a card in your case', 'gold'); return; }
  }
  document.getElementById('smATBtn').disabled = true;
  const card = await _smAddNewCard(f, _smPriceValue('smAT_price'), captureId || null);
  try { sessionStorage.removeItem('smAddDraft'); } catch (_) {}
  showToast(`✓ ${card.Player} added to your case`);
  if (captureId) { _smAddedCount++; history.back(); return; }   // came from the camera: back to it
  smRenderAddType();   // typing: a fresh form for the next card
}

// Test hooks (pure functions only).
window.__smTest = { smChipPrice, smMergeIdentification, smScoreMatch, _smFromClaude, _smFromCardSight };
