// js/trade-zone.js
// Guest quick-post flow + personal board/trade management for trade-zone.html.
// Standalone from app.html — talks only to the Trade Zone tables
// (trade_zone_shows, traders, trade_posts, trades, share_events) via the
// `db` Supabase client created inline in trade-zone.html, plus the RPC
// functions defined in supabase/migrations/20260825120000_trade_zone.sql.
//
// Depends on trade-share.js being loaded first for TradeShare.* (Phase 4
// compositor + Web Share API). Never touches inventory/, shows/,
// show_sellers/, show_inventory — see CLAUDE.md "Trade Zone" section.

const TZ = {
  show: null,          // { id, name, location, starts_at, ends_at }
  trader: null,        // { id, handle, phone, claimed_at }
  myPosts: [],         // trade_posts where trader_id === me, any status
  boardPosts: [],      // trade_posts for this show, status='open', not mine
  myTrades: [],        // trades where I'm trader_a or trader_b
  postCache: {},       // id -> trade_post, populated as trades reference them
  realtimeChannel: null,
  proposeTargetPost: null, // the board post currently being offered a trade against
};

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

async function tzInit() {
  tzShowLoading('Setting up your session…');
  try {
    await tzEnsureGuestSession();
    await tzEnsureTraderRow();
    await tzResolveShow();
    await tzRefreshAll();
    tzWireRealtime();
    tzHideLoading();

    const params = new URLSearchParams(location.search);
    const tradeParam = params.get('trade');
    if (tradeParam) {
      tzSwitchTab('trades');
      tzOpenTradeDetail(tradeParam);
    }
  } catch (err) {
    console.error('[trade-zone] init failed:', err);
    tzShowFatalError(err.message || 'Something went wrong loading Trade Zone.');
  }
}

async function tzEnsureGuestSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session) return session;

  const { data, error } = await db.auth.signInAnonymously();
  if (error) throw new Error('Could not start a guest session: ' + error.message);
  return data.session;
}

async function tzEnsureTraderRow() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('No active session');

  // Upsert so re-visiting the page never overwrites an already-claimed handle/phone.
  const { error: upsertErr } = await db
    .from('traders')
    .upsert({ id: user.id }, { onConflict: 'id', ignoreDuplicates: true });
  if (upsertErr) console.warn('[trade-zone] trader upsert warning:', upsertErr.message);

  const { data: trader, error } = await db
    .from('traders')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new Error('Could not load trader profile: ' + error.message);

  TZ.trader = trader || { id: user.id, handle: null, phone: null, claimed_at: null };
  tzRenderClaimStatus();
}

// Picks a show: explicit ?show= wins; otherwise the show currently in
// progress, else the most recently ended one, else the soonest upcoming.
async function tzResolveShow() {
  const params = new URLSearchParams(location.search);
  const explicitId = params.get('show');

  const { data: shows, error } = await db
    .from('trade_zone_shows')
    .select('*')
    .order('starts_at', { ascending: true });
  if (error) throw new Error('Could not load shows: ' + error.message);
  if (!shows || !shows.length) throw new Error('No Trade Zone shows are set up yet.');

  if (explicitId) {
    const match = shows.find(s => s.id === explicitId);
    if (match) { TZ.show = match; return; }
  }

  const now = Date.now();
  const inProgress = shows.find(s => now >= new Date(s.starts_at).getTime() && now <= new Date(s.ends_at).getTime());
  if (inProgress) { TZ.show = inProgress; return; }

  const upcoming = shows.filter(s => new Date(s.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  if (upcoming) { TZ.show = upcoming; return; }

  TZ.show = shows[shows.length - 1]; // most recent past show
}

async function tzRefreshAll() {
  tzRenderShowHeader();
  await Promise.all([tzFetchMyPosts(), tzFetchBoard(), tzFetchMyTrades()]);
}

// ─────────────────────────────────────────────────────────
// IMAGE CAPTURE + RESIZE
// ─────────────────────────────────────────────────────────

// Mirrors app.html's _posCompressImage() convention (canvas resize,
// JPEG output) but returns a Blob for direct Storage upload rather than
// a base64 string for a vision API call.
function _tzResizeImageToBlob(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else       { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas export failed')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

let _tzPostPhotoFile = null;
let _tzPostPhotoPreviewUrl = null;
let _tzVisionAbort = null;

function tzTriggerCamera()  { document.getElementById('tzPostFileInput').click(); }
function tzTriggerLibrary() { document.getElementById('tzPostLibraryInput').click(); }

function tzHandlePostPhoto(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  _tzPostPhotoFile = file;
  if (_tzPostPhotoPreviewUrl) URL.revokeObjectURL(_tzPostPhotoPreviewUrl);
  _tzPostPhotoPreviewUrl = URL.createObjectURL(file);

  document.getElementById('tzPostPhotoPreview').src = _tzPostPhotoPreviewUrl;
  document.getElementById('tzPostPhotoPreviewWrap').style.display = 'block';
  document.getElementById('tzPostPhotoPrompt').style.display = 'none';
  tzUpdatePostSubmitState();

  _tzRunVisionOnPhoto(file);
}

function tzClearPostPhoto() {
  _tzPostPhotoFile = null;
  if (_tzPostPhotoPreviewUrl) { URL.revokeObjectURL(_tzPostPhotoPreviewUrl); _tzPostPhotoPreviewUrl = null; }
  if (_tzVisionAbort) { _tzVisionAbort.abort(); _tzVisionAbort = null; }
  document.getElementById('tzPostFileInput').value = '';
  document.getElementById('tzPostLibraryInput').value = '';
  document.getElementById('tzPostPhotoPreviewWrap').style.display = 'none';
  document.getElementById('tzPostPhotoPrompt').style.display = 'flex';
  _tzHideVisionStatus();
  tzUpdatePostSubmitState();
}

let _tzPostCondition = 'raw';
function tzSetPostCondition(val, btnEl) {
  _tzPostCondition = val;
  document.querySelectorAll('.tz-condition-chip').forEach(el => el.classList.remove('selected'));
  if (btnEl) btnEl.classList.add('selected');
}

function _tzSelectConditionChip(val) {
  const chip = document.querySelector(`.tz-condition-chip[data-val="${val}"]`);
  if (chip) tzSetPostCondition(val, chip);
}

function tzUpdatePostSubmitState() {
  const nameOk = document.getElementById('tzPostCardName').value.trim().length > 0;
  document.getElementById('tzPostSubmitBtn').disabled = !(nameOk && _tzPostPhotoFile);
}

// ─────────────────────────────────────────────────────────
// VISION AUTO-FILL — same cascade seller inventory uses (vision-scan.js
// via a direct fetch(), not through _callVisionScan()/app.html, which is
// hard-wired to the Add Card modal and unavailable on this standalone
// page). Trade posts only carry a free-text card_name + condition, so
// this fills those two fields instead of a full structured card form.
// ─────────────────────────────────────────────────────────

// Mirrors app.html's _posCompressImage() exactly (1024px / JPEG 85% /
// base64) — vision-scan.js needs base64, not the Blob _tzResizeImageToBlob()
// produces for Storage upload.
function _tzImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// Verbatim port of app.html's buildCardTitle() — same sport-aware
// synthesis (TCG game-label prefix vs. plain "year set player parallel"
// for everything else), so a Trade Zone post reads the same way an
// inventory card's title would for the same photo.
function _tzBuildCardTitle(card) {
  const year     = String(card.year     ?? '').trim();
  const name     = String(card.player   ?? '').trim();
  const set      = String(card.cardSet  ?? '').trim();
  const parallel = String(card.parallel ?? '').trim();
  const cardNum  = String(card.cardNum  ?? '').trim();
  const sport    = String(card.sport    ?? '').trim();
  const raw      = String(card.rawTitle ?? '').toLowerCase();
  const setLower = set.toLowerCase();

  if (sport === 'TCG') {
    let game = '';
    if (/pokemon/.test(raw) || /pokemon/.test(setLower)) {
      game = setLower.startsWith('pokemon') ? '' : 'Pokemon';
    } else if (/magic|mtg/.test(raw) || /magic|mtg/.test(setLower)) {
      game = /^magic|^mtg/.test(setLower) ? '' : 'Magic The Gathering';
    } else if (/one piece/.test(raw) || /one.piece/.test(setLower)) {
      game = /^one piece/.test(setLower) ? '' : 'One Piece Card Game';
    } else if (/yu.gi.oh/.test(raw) || /yu.gi.oh/.test(setLower)) {
      game = /^yu.gi.oh/.test(setLower) ? '' : 'Yu-Gi-Oh!';
    }

    const parts = [year, game, set, name];
    if (cardNum) parts.push(`#${cardNum}`);
    if (parallel) parts.push(parallel);
    return parts.filter(Boolean).join(' ');
  }

  return [year, set, name, parallel].filter(Boolean).join(' ');
}

// Maps a vision result to one of Trade Zone's condition chips —
// there's no numeric grade field here, just raw/psa10/psa9/bgs/other.
function _tzInferCondition(card) {
  const grader = String(card.grader || '').toUpperCase();
  const grade  = Number(card.grade);
  if (!grader) return 'raw';
  if (grader === 'BGS') return 'bgs';
  if (grader === 'PSA' && grade === 10) return 'psa10';
  if (grader === 'PSA' && grade === 9)  return 'psa9';
  return 'other';
}

function _tzShowVisionStatus(msg) {
  const el = document.getElementById('tzVisionStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
function _tzHideVisionStatus() {
  const el = document.getElementById('tzVisionStatus');
  if (el) el.style.display = 'none';
}

async function _tzRunVisionOnPhoto(file) {
  if (_tzVisionAbort) _tzVisionAbort.abort();
  const controller = new AbortController();
  _tzVisionAbort = controller;

  // Snapshot the field as of right now (should be empty, since a photo
  // was just added) so we never clobber text the guest typed manually
  // while this call was still in flight — vision takes 1-3s, plenty of
  // time to start typing a name by hand.
  const nameElAtStart = document.getElementById('tzPostCardName');
  const valueAtStart = nameElAtStart ? nameElAtStart.value : '';

  _tzShowVisionStatus('🔍 Identifying card…');

  try {
    const base64 = await _tzImageToBase64(file);
    if (controller.signal.aborted) return;

    const response = await fetch('/.netlify/functions/vision-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType: 'image/jpeg' }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(`Server error ${response.status}`);

    const result = await response.json();
    if (controller.signal.aborted) return;

    if (!result.success || result.error === 'low_confidence') {
      _tzHideVisionStatus();
      return; // silent fallback — guest just types the name manually
    }

    const card = result.card;
    const title = _tzBuildCardTitle(card) || card.rawTitle || '';
    const nameEl = document.getElementById('tzPostCardName');
    const untouched = nameEl && nameEl.value === valueAtStart;

    if (title && untouched) {
      nameEl.value = title;
      nameEl.classList.add('tz-vision-filled');
      setTimeout(() => nameEl.classList.remove('tz-vision-filled'), 4000);
      tzUpdatePostSubmitState();
    }

    if (untouched) _tzSelectConditionChip(_tzInferCondition(card));
    _tzHideVisionStatus();
    if (title && untouched) tzToast('✓ Card identified — review & post');
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a retake
    console.warn('[trade-zone] vision identify failed:', err.message);
    _tzHideVisionStatus();
    // Non-fatal — falls through to manual entry, same as every other
    // vision-scan.js caller in this codebase.
  } finally {
    if (_tzVisionAbort === controller) _tzVisionAbort = null;
  }
}

// ─────────────────────────────────────────────────────────
// PHASE 1 — CREATE POST
// ─────────────────────────────────────────────────────────

async function tzSubmitPost() {
  const cardName   = document.getElementById('tzPostCardName').value.trim();
  const lookingFor = document.getElementById('tzPostLookingFor').value.trim();

  if (!cardName)          return tzToast('Add the card name first', 'var(--danger, #ef4444)');
  if (!_tzPostPhotoFile)  return tzToast('Add a photo first', 'var(--danger, #ef4444)');
  if (!TZ.show)           return tzToast('No active show — cannot post', 'var(--danger, #ef4444)');

  const btn = document.getElementById('tzPostSubmitBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Posting…';

  try {
    const postId = crypto.randomUUID();

    const [mainBlob, thumbBlob] = await Promise.all([
      _tzResizeImageToBlob(_tzPostPhotoFile, 1200, 0.8),
      _tzResizeImageToBlob(_tzPostPhotoFile, 300, 0.7),
    ]);

    const mainPath  = `posts/${postId}/original.jpg`;
    const thumbPath = `posts/${postId}/thumb.jpg`;

    const [mainUp, thumbUp] = await Promise.all([
      db.storage.from('trade-zone-cards').upload(mainPath, mainBlob, { contentType: 'image/jpeg', upsert: true }),
      db.storage.from('trade-zone-cards').upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: true }),
    ]);
    if (mainUp.error) throw new Error('Image upload failed: ' + mainUp.error.message);
    if (thumbUp.error) throw new Error('Thumbnail upload failed: ' + thumbUp.error.message);

    const imageUrl = db.storage.from('trade-zone-cards').getPublicUrl(mainPath).data.publicUrl;
    const thumbUrl = db.storage.from('trade-zone-cards').getPublicUrl(thumbPath).data.publicUrl;

    const { error: insertErr } = await db.from('trade_posts').insert({
      id: postId,
      show_id: TZ.show.id,
      trader_id: TZ.trader.id,
      card_name: cardName,
      condition: _tzPostCondition,
      looking_for: lookingFor || null,
      image_url: imageUrl,
      thumb_url: thumbUrl,
      status: 'open',
    });
    if (insertErr) throw new Error('Could not save your post: ' + insertErr.message);

    tzToast('Posted to the board!');
    document.getElementById('tzPostCardName').value = '';
    document.getElementById('tzPostLookingFor').value = '';
    tzClearPostPhoto();
    tzSetPostCondition('raw', document.querySelector('.tz-condition-chip[data-val="raw"]'));

    await Promise.all([tzFetchMyPosts(), tzFetchBoard()]);
    tzSwitchTab('board');
  } catch (err) {
    console.error('[trade-zone] post failed:', err);
    tzToast(err.message, 'var(--danger, #ef4444)');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
    tzUpdatePostSubmitState();
  }
}

async function tzFetchMyPosts() {
  if (!TZ.trader) return;
  const { data, error } = await db
    .from('trade_posts')
    .select('*')
    .eq('trader_id', TZ.trader.id)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[trade-zone] fetch my posts failed:', error.message); return; }
  TZ.myPosts = data || [];
  TZ.myPosts.forEach(p => TZ.postCache[p.id] = p);
  tzRenderMyPosts();
}

// ─────────────────────────────────────────────────────────
// PHASE 2/3 — BOARD + PROPOSE TRADE
// ─────────────────────────────────────────────────────────

async function tzFetchBoard() {
  if (!TZ.show || !TZ.trader) return;
  const { data, error } = await db
    .from('trade_posts')
    .select('*')
    .eq('show_id', TZ.show.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { console.warn('[trade-zone] fetch board failed:', error.message); return; }
  TZ.boardPosts = (data || []).filter(p => p.trader_id !== TZ.trader.id);
  TZ.boardPosts.forEach(p => TZ.postCache[p.id] = p);
  tzRenderBoard();
}

function tzWireRealtime() {
  if (!TZ.show || TZ.realtimeChannel) return;
  TZ.realtimeChannel = db
    .channel(`trade_posts_${TZ.show.id}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'trade_posts', filter: `show_id=eq.${TZ.show.id}` },
      () => { tzFetchBoard(); tzFetchMyPosts(); })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'trades', filter: `show_id=eq.${TZ.show.id}` },
      () => { tzFetchMyTrades(); })
    .subscribe();
}

function tzOpenProposeModal(postId) {
  const post = TZ.postCache[postId];
  if (!post) return;
  const myOpenPosts = TZ.myPosts.filter(p => p.status === 'open');
  if (!myOpenPosts.length) {
    tzToast('Post a card of your own first — you need something to offer', 'var(--danger, #ef4444)');
    tzSwitchTab('post');
    return;
  }
  TZ.proposeTargetPost = post;
  document.getElementById('tzProposeTargetName').textContent = post.card_name;
  document.getElementById('tzProposeTargetThumb').src = post.thumb_url;

  const list = document.getElementById('tzProposeMyPostsList');
  list.innerHTML = myOpenPosts.map(p => `
    <button class="tz-propose-option" onclick="tzConfirmPropose('${p.id}')">
      <img src="${p.thumb_url}" alt="">
      <span>${tzEsc(p.card_name)}</span>
    </button>
  `).join('');

  document.getElementById('tzProposeOverlay').classList.add('open');
}

function tzCloseProposeModal() {
  document.getElementById('tzProposeOverlay').classList.remove('open');
  TZ.proposeTargetPost = null;
}

async function tzConfirmPropose(myPostId) {
  if (!TZ.proposeTargetPost) return;
  try {
    const { error } = await db.rpc('propose_trade', {
      p_post_a_id: myPostId,
      p_post_b_id: TZ.proposeTargetPost.id,
    });
    if (error) throw new Error(error.message);
    tzToast('Trade proposed — waiting on the other trader to confirm');
    tzCloseProposeModal();
    await Promise.all([tzFetchMyPosts(), tzFetchBoard(), tzFetchMyTrades()]);
    tzSwitchTab('trades');
  } catch (err) {
    console.error('[trade-zone] propose failed:', err);
    tzToast(err.message, 'var(--danger, #ef4444)');
  }
}

// ─────────────────────────────────────────────────────────
// PHASE 3 — MY TRADES + CONFIRM
// ─────────────────────────────────────────────────────────

async function tzFetchMyTrades() {
  if (!TZ.trader) return;
  const { data, error } = await db
    .from('trades')
    .select('*')
    .or(`trader_a_id.eq.${TZ.trader.id},trader_b_id.eq.${TZ.trader.id}`)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[trade-zone] fetch my trades failed:', error.message); return; }
  TZ.myTrades = data || [];

  // Backfill any referenced posts we haven't cached yet (e.g. the other
  // trader's post, which never came through tzFetchMyPosts/tzFetchBoard).
  const missingIds = new Set();
  TZ.myTrades.forEach(t => {
    if (!TZ.postCache[t.post_a_id]) missingIds.add(t.post_a_id);
    if (!TZ.postCache[t.post_b_id]) missingIds.add(t.post_b_id);
  });
  if (missingIds.size) {
    const { data: posts } = await db.from('trade_posts').select('*').in('id', [...missingIds]);
    (posts || []).forEach(p => TZ.postCache[p.id] = p);
  }

  tzRenderMyTrades();
}

async function tzConfirmTrade(tradeId) {
  try {
    const { error } = await db.rpc('confirm_trade', { p_trade_id: tradeId });
    if (error) throw new Error(error.message);
    tzToast('Confirmed!');
    await Promise.all([tzFetchMyTrades(), tzFetchMyPosts()]);
  } catch (err) {
    console.error('[trade-zone] confirm failed:', err);
    tzToast(err.message, 'var(--danger, #ef4444)');
  }
}

// Deep-linked from a /trade/:id share URL (see trade-og.js).
async function tzOpenTradeDetail(tradeId) {
  const el = document.getElementById(`tzTradeCard_${tradeId}`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('tz-highlight'); return; }
  tzToast('Loading that trade…');
  const { data: trade } = await db.from('trades').select('*').eq('id', tradeId).maybeSingle();
  if (!trade) return tzToast('Trade not found', 'var(--danger, #ef4444)');
  if (!TZ.myTrades.find(t => t.id === trade.id)) TZ.myTrades.unshift(trade);
  const ids = [trade.post_a_id, trade.post_b_id].filter(id => !TZ.postCache[id]);
  if (ids.length) {
    const { data: posts } = await db.from('trade_posts').select('*').in('id', ids);
    (posts || []).forEach(p => TZ.postCache[p.id] = p);
  }
  tzRenderMyTrades();
  setTimeout(() => tzOpenTradeDetail(tradeId), 50);
}

// ─────────────────────────────────────────────────────────
// PHASE 6 — CLAIM FLOW
// ─────────────────────────────────────────────────────────

function tzOpenClaimModal() {
  document.getElementById('tzClaimOverlay').classList.add('open');
}
function tzCloseClaimModal() {
  document.getElementById('tzClaimOverlay').classList.remove('open');
}

async function tzSubmitClaim() {
  const email   = document.getElementById('tzClaimEmail').value.trim();
  const pass    = document.getElementById('tzClaimPassword').value;
  const handle  = document.getElementById('tzClaimHandle').value.trim();
  const phone   = document.getElementById('tzClaimPhone').value.trim();

  if (!email || !pass) return tzToast('Email and password are required to claim', 'var(--danger, #ef4444)');
  if (pass.length < 6) return tzToast('Password must be at least 6 characters', 'var(--danger, #ef4444)');

  const btn = document.getElementById('tzClaimSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Claiming…';

  try {
    // Converts the anonymous session into a permanent account in place —
    // same auth.uid(), so every trade_posts/trades row already tied to
    // this identity carries over with zero migration (Supabase's native
    // anonymous → permanent linking flow).
    const { error: updateErr } = await db.auth.updateUser({ email, password: pass });
    if (updateErr) throw new Error(updateErr.message);

    const { error: dbErr } = await db.from('traders').update({
      handle: handle || null,
      phone: phone || null,
      claimed_at: new Date().toISOString(),
    }).eq('id', TZ.trader.id);
    if (dbErr) throw new Error(dbErr.message);

    TZ.trader = { ...TZ.trader, handle: handle || null, phone: phone || null, claimed_at: new Date().toISOString() };
    tzRenderClaimStatus();
    tzToast('Claimed! Check your email to confirm the address.');
    tzCloseClaimModal();
  } catch (err) {
    console.error('[trade-zone] claim failed:', err);
    tzToast(err.message, 'var(--danger, #ef4444)');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Claim my activity';
  }
}

// ─────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────

function tzEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TZ_CONDITION_LABELS = { raw: 'Raw', psa10: 'PSA 10', psa9: 'PSA 9', bgs: 'BGS', other: 'Other' };

function tzRenderShowHeader() {
  const el = document.getElementById('tzShowHeader');
  if (!el || !TZ.show) return;
  el.innerHTML = `
    <div class="tz-show-name">${tzEsc(TZ.show.name)}</div>
    ${TZ.show.location ? `<div class="tz-show-location">${tzEsc(TZ.show.location)}</div>` : ''}
  `;
}

function tzRenderClaimStatus() {
  const el = document.getElementById('tzClaimStatus');
  if (!el) return;
  if (TZ.trader && TZ.trader.claimed_at) {
    el.innerHTML = `<span class="tz-claimed-badge">✓ Claimed${TZ.trader.handle ? ' as ' + tzEsc(TZ.trader.handle) : ''}</span>`;
  } else {
    el.innerHTML = `<button class="tz-claim-btn" onclick="tzOpenClaimModal()">Claim your Trade Zone activity</button>`;
  }
}

function tzPostCardHTML(post, opts = {}) {
  const cond = TZ_CONDITION_LABELS[post.condition] || post.condition || '';
  return `
    <div class="tz-post-card">
      <img class="tz-post-thumb" src="${post.thumb_url}" alt="${tzEsc(post.card_name)}" loading="lazy">
      <div class="tz-post-body">
        <div class="tz-post-name">${tzEsc(post.card_name)}</div>
        <div class="tz-post-meta">
          ${cond ? `<span class="tz-badge">${tzEsc(cond)}</span>` : ''}
          <span class="tz-badge tz-badge-status tz-status-${post.status}">${post.status}</span>
        </div>
        ${post.looking_for ? `<div class="tz-post-looking">Looking for: ${tzEsc(post.looking_for)}</div>` : ''}
        ${opts.actionHTML || ''}
      </div>
    </div>
  `;
}

function tzRenderMyPosts() {
  const el = document.getElementById('tzMyPostsList');
  if (!el) return;
  if (!TZ.myPosts.length) {
    el.innerHTML = `<div class="tz-empty">You haven't posted a card yet.</div>`;
    return;
  }
  el.innerHTML = TZ.myPosts.map(p => tzPostCardHTML(p)).join('');
}

function tzRenderBoard() {
  const el = document.getElementById('tzBoardGrid');
  if (!el) return;
  if (!TZ.boardPosts.length) {
    el.innerHTML = `<div class="tz-empty">No open posts yet — be the first to post a card!</div>`;
    return;
  }
  el.innerHTML = TZ.boardPosts.map(p => tzPostCardHTML(p, {
    actionHTML: `<button class="tz-propose-btn" onclick="tzOpenProposeModal('${p.id}')">Propose Trade</button>`,
  })).join('');
}

function tzIsParty(trade) {
  return trade.trader_a_id === TZ.trader.id || trade.trader_b_id === TZ.trader.id;
}

function tzTradeStatusLabel(trade) {
  if (trade.confirmed_at) return { text: '✓ Traded', cls: 'traded' };
  if (!tzIsParty(trade)) return { text: 'Pending confirmation', cls: 'pending' };
  const iAmA = trade.trader_a_id === TZ.trader.id;
  const iConfirmed = iAmA ? trade.confirmed_a : trade.confirmed_b;
  if (iConfirmed) return { text: 'Waiting on the other trader…', cls: 'pending' };
  return { text: 'Awaiting your confirmation', cls: 'action' };
}

function tzRenderMyTrades() {
  const el = document.getElementById('tzTradesList');
  if (!el) return;
  if (!TZ.myTrades.length) {
    el.innerHTML = `<div class="tz-empty">No trades yet — propose one from the board.</div>`;
    return;
  }
  el.innerHTML = TZ.myTrades.map(t => {
    const postA = TZ.postCache[t.post_a_id];
    const postB = TZ.postCache[t.post_b_id];
    const status = tzTradeStatusLabel(t);
    const isParty = tzIsParty(t);
    const iAmA = t.trader_a_id === TZ.trader.id;
    const iConfirmed = isParty && (iAmA ? t.confirmed_a : t.confirmed_b);

    return `
      <div class="tz-trade-card" id="tzTradeCard_${t.id}">
        <div class="tz-trade-swap">
          ${postA ? `<img class="tz-trade-thumb" src="${postA.thumb_url}" alt="">` : '<div class="tz-trade-thumb tz-thumb-missing"></div>'}
          <span class="tz-swap-icon">⇄</span>
          ${postB ? `<img class="tz-trade-thumb" src="${postB.thumb_url}" alt="">` : '<div class="tz-trade-thumb tz-thumb-missing"></div>'}
        </div>
        <div class="tz-trade-names">
          <span>${postA ? tzEsc(postA.card_name) : '…'}</span>
          <span>${postB ? tzEsc(postB.card_name) : '…'}</span>
        </div>
        <div class="tz-trade-status tz-trade-status-${status.cls}">${status.text}</div>
        ${isParty && !iConfirmed ? `<button class="tz-confirm-btn" onclick="tzConfirmTrade('${t.id}')">Confirm This Trade</button>` : ''}
        ${t.confirmed_at ? `<div id="tzShareSlot_${t.id}"></div>` : ''}
      </div>
    `;
  }).join('');

  // Phase 4 hook: render the share/consent UI into each confirmed trade's slot.
  TZ.myTrades.filter(t => t.confirmed_at).forEach(t => {
    const slot = document.getElementById(`tzShareSlot_${t.id}`);
    if (slot && window.TradeShare) window.TradeShare.renderShareSlot(slot, t, TZ.postCache);
  });
}

// ─────────────────────────────────────────────────────────
// TABS / MISC UI
// ─────────────────────────────────────────────────────────

function tzSwitchTab(tab) {
  document.querySelectorAll('.tz-tab-panel').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tz-tab-btn').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById(`tzTab_${tab}`);
  const btn = document.getElementById(`tzTabBtn_${tab}`);
  if (panel) panel.style.display = 'block';
  if (btn) btn.classList.add('active');
}

function tzToast(msg, color) {
  const t = document.getElementById('tzToast');
  if (!t) return;
  t.textContent = msg;
  t.style.background = color || '#1BAF7A';
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function tzShowLoading(msg) {
  const el = document.getElementById('tzLoadingOverlay');
  if (!el) return;
  document.getElementById('tzLoadingMsg').textContent = msg;
  el.style.display = 'flex';
}
function tzHideLoading() {
  const el = document.getElementById('tzLoadingOverlay');
  if (el) el.style.display = 'none';
}
function tzShowFatalError(msg) {
  const el = document.getElementById('tzLoadingOverlay');
  if (!el) return;
  el.innerHTML = `<div class="tz-fatal-error"><div class="tz-fatal-icon">⚠</div><div>${tzEsc(msg)}</div></div>`;
  el.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', tzInit);
