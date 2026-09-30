// gtcr-registry.js — GTCR consent + registration lifecycle (Phases 3 & 4 of
// "Trust Check via GTCR" in CLAUDE.md)
//
// Uses the dedicated PARTNER WRITE key only (GTCR_WRITE_API_KEY). It never
// uses the read key.
//
// Every action requires `Authorization: Bearer <supabase access token>`. The
// seller is always the authenticated user (sellers.id = auth.uid()), and
// seller_email is the verified Supabase Auth email. Neither is ever taken from
// the request body.
//
// POST { action: 'status' }
//   → { success, enabled, consented, consented_at, consent_copy_version,
//       registered_count, pending_removals }
// POST { action: 'grant', consent_copy_version }
//   Appends a 'granted' consent event (server clock, IP, user-agent). Refused
//   unless GTCR_REGISTRATION_ENABLED === 'true'. The feature stays dark until
//   pricing/packaging is decided.
// POST { action: 'revoke', consent_copy_version }
//   Appends a 'revoked' consent event, then starts removing registrations (reconcile).
//   Always allowed, even while the feature is disabled.
// POST { action: 'reconcile' }   (aliases: 'drain_removals', 'register')
//   Brings the seller's GTCR registrations in line with their inventory.
//   Option A: a graded card is registered while the seller owns it, and the
//   registration is removed when the card is sold, deleted, has its cert #
//   or grader changed, gets a stolen/lost flag (or a dispute), or the seller
//   withdraws consent. Removals always run; new registrations only run while
//   GTCR_REGISTRATION_ENABLED is 'true' and the seller's latest consent event
//   is 'granted'. Works within a time budget and returns what's left; the
//   client calls again until remaining is 0 or nothing moves.
//   A card is only registered after a clean Trust Check from the last 24h for
//   its current cert and grader; the rest are reported as awaiting_check.
//   → { success, registered, removed, failed, remaining, unlinked, awaiting_check, auth_error }
//
// Env: GTCR_WRITE_API_KEY, GTCR_REGISTRATION_ENABLED ('true' to allow grant +
// register), GTCR_API_BASE, GTCR_PARTNER_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');

const GTCR_API_BASE    = (process.env.GTCR_API_BASE || 'https://thegtcr.com/functions').replace(/\/+$/, '');
const GTCR_PARTNER_ID  = process.env.GTCR_PARTNER_ID || 'cardshow';
const GTCR_TIMEOUT_MS  = 4000;
const RECONCILE_BUDGET_MS = 6500; // stay under Netlify's ~10s synchronous ceiling
const FAILED_RETRY_MS  = 6 * 60 * 60 * 1000; // don't retry a rejected registration for 6h
// A card is only registered after a clean Trust Check this recent, for the
// card's current cert and grader. The app re-checks older cards first.
const TRUST_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DESCRIPTION_MAX  = 300;
const REGISTRATION_ENABLED = () => process.env.GTCR_REGISTRATION_ENABLED === 'true';
// The consent wording sellers currently agree to. Must match
// GTCR_CONSENT_COPY_VERSION in app.html. A 'granted' event for an older
// version doesn't count: the seller has to agree to the new wording.
const CURRENT_CONSENT_COPY_VERSION = '2026-09-30-draft2';

// Duplicated from gtcr-trust-check.js (no shared module in this repo).
// GTCR's enum lists "BGS (Beckett)"; we send "BGS". Confirm with GTCR which
// string it expects and change it here if needed.
const GTCR_GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'HGA', 'TAG', 'AGS', 'C3G', 'DGA'];
function toGtcrGrader(g) {
  const up = String(g || '').trim().toUpperCase();
  if (!up) return null;
  return GTCR_GRADERS.includes(up) ? up : 'Other';
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || null;
}

async function gtcrWrite(fnName, payload) {
  const key = process.env.GTCR_WRITE_API_KEY;
  if (!key) throw new Error('GTCR_WRITE_API_KEY not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GTCR_TIMEOUT_MS);
  try {
    const res = await fetch(`${GTCR_API_BASE}/${fnName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gtcr-api-key': key },
      body: JSON.stringify({ ...payload, partner_id: GTCR_PARTNER_ID }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* non-JSON */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function latestConsent(db, sellerId) {
  const { data } = await db.from('gtcr_consent_events')
    .select('id, action, occurred_at, consent_copy_version')
    .eq('seller_id', sellerId)
    .order('occurred_at', { ascending: false })
    .limit(1).maybeSingle();
  return data || null;
}

// Consent counts only when the latest event is 'granted' for the current wording.
function consentIsCurrent(consent) {
  return consent?.action === 'granted' && consent.consent_copy_version === CURRENT_CONSENT_COPY_VERSION;
}

async function countActiveRegistrations(db, sellerId) {
  const { count } = await db.from('gtcr_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId).eq('status', 'registered');
  return count || 0;
}

async function handleStatus(db, user) {
  const consent = await latestConsent(db, user.id);
  const consented = consentIsCurrent(consent);
  const active = await countActiveRegistrations(db, user.id);
  return json(200, {
    success: true,
    enabled: REGISTRATION_ENABLED(),
    consented,
    consent_outdated: consent?.action === 'granted' && !consented,
    consented_at: consented ? consent.occurred_at : null,
    consent_copy_version: consented ? consent.consent_copy_version : null,
    registered_count: active,
    pending_removals: consented ? 0 : active,
  });
}

async function recordConsentEvent(db, user, event, action, copyVersion) {
  const ip = header(event, 'x-nf-client-connection-ip')
    || (header(event, 'x-forwarded-for') || '').split(',')[0].trim() || null;
  const { data, error } = await db.from('gtcr_consent_events').insert({
    seller_id: user.id,
    action,
    consent_copy_version: copyVersion,
    ip_address: ip,
    user_agent: (header(event, 'user-agent') || '').slice(0, 500) || null,
  }).select('id, occurred_at').maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function handleGrant(db, user, event, input) {
  if (!REGISTRATION_ENABLED()) return json(403, { success: false, error: 'registration_disabled' });
  const copyVersion = String(input.consent_copy_version || '').trim();
  if (!copyVersion) return json(400, { success: false, error: 'consent_copy_version required' });
  if (copyVersion !== CURRENT_CONSENT_COPY_VERSION) {
    return json(409, { success: false, error: 'consent_copy_outdated' });
  }
  const current = await latestConsent(db, user.id);
  if (consentIsCurrent(current)) {
    // Already consented to this wording. Keep the original moment.
    return json(200, { success: true, consented: true, consented_at: current.occurred_at });
  }
  const ev = await recordConsentEvent(db, user, event, 'granted', copyVersion);
  return json(200, { success: true, consented: true, consented_at: ev.occurred_at });
}

function certKey(cert, grader) {
  return `${String(cert || '').trim().toLowerCase()}|${grader || ''}`;
}

// Every card the seller owns in inventory (up to 5000). trust_flag comes from
// the Trust Check migration; if that column is missing, retry without it.
async function loadInventory(db, sellerId) {
  const base = 'id, status, card_title, player, year, card_set, parallel, grader, grade, cert_number';
  const rows = [];
  for (let from = 0; from < 5000; from += 1000) {
    let { data, error } = await db.from('inventory').select(base + ', trust_flag')
      .eq('seller_id', sellerId).range(from, from + 999);
    if (error && /trust_flag/.test(error.message || '')) {
      ({ data, error } = await db.from('inventory').select(base)
        .eq('seller_id', sellerId).range(from, from + 999));
    }
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// Inventory ids whose latest Trust Check is recent, clean, and for the card's
// current cert and grader. A card with no such check isn't registered yet.
async function cleanRecentlyChecked(db, cards) {
  const ok = new Set();
  const since = new Date(Date.now() - TRUST_CHECK_MAX_AGE_MS).toISOString();
  const byId = new Map(cards.map(c => [c.id, c]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('cert_trust_checks')
      .select('inventory_id, cert_number, grading_company, matched, checked_at')
      .in('inventory_id', ids.slice(i, i + 200))
      .gte('checked_at', since)
      .order('checked_at', { ascending: false });
    if (error) { console.warn('[gtcr-registry] trust check lookup failed:', error.message); continue; }
    const seen = new Set();
    for (const row of data || []) {
      if (seen.has(row.inventory_id)) continue; // newest first: only the latest counts
      seen.add(row.inventory_id);
      const card = byId.get(row.inventory_id);
      const sameSlab = certKey(row.cert_number, row.grading_company)
        === certKey(card.cert_number, toGtcrGrader(card.grader));
      if (!row.matched && sameSlab) ok.add(row.inventory_id);
    }
  }
  return ok;
}

function describe(card) {
  return String(card.card_title
    || [card.year, card.card_set, card.player, card.parallel].filter(Boolean).join(' ')).slice(0, DESCRIPTION_MAX);
}

// Why an active registration no longer belongs. null means keep it.
function removalReason(reg, invById, desiredByKey, consented) {
  if (!consented) return 'seller_consent_revoked';
  const card = reg.inventory_id ? invById.get(reg.inventory_id) : null;
  const want = desiredByKey.get(certKey(reg.cert_number, reg.grading_company));
  if (want) return null;
  if (!card) return 'card_deleted';
  if (card.status === 'Sold') return 'card_sold';
  if (card.trust_flag === 'flagged' || card.trust_flag === 'disputed') return 'trust_report';
  return 'card_details_changed';
}

async function removeOne(db, user, reg, reason) {
  const res = await gtcrWrite('removeRegistrationApi', {
    cert_number: reg.cert_number,
    grading_company: reg.grading_company,
    // GTCR only removes a registration for the email it was registered with.
    seller_email: reg.owner_email || user.email,
    reason,
  });
  // 200 removed, or 404 not_found (already gone; idempotent): both mean it's gone.
  if (res.status === 200 || res.status === 404) {
    await db.from('gtcr_registrations').update({
      status: 'removed',
      removed_at: new Date().toISOString(),
      remove_reason: reason,
      remove_gtcr_status: res.status === 404 ? 'not_found' : (res.body?.status || 'removed'),
    }).eq('id', reg.id);
    return { ok: true };
  }
  return { ok: false, status: res.status, error: res.body?.error || res.text.slice(0, 200) };
}

async function registerOne(db, user, card, grader, consent, sellerName) {
  const payload = {
    cert_number: String(card.cert_number).trim(),
    grading_company: grader,
    card_description: describe(card),
    seller_email: user.email,
    seller_consent: true,
    consent_timestamp: new Date(consent.occurred_at).toISOString(),
  };
  if (card.grade != null && card.grade !== '') payload.grade = String(card.grade);
  if (sellerName) payload.seller_name = sellerName;

  const res = await gtcrWrite('registerCardApi', payload);
  const base = {
    seller_id: user.id,
    inventory_id: card.id,
    consent_event_id: consent.id,
    cert_number: payload.cert_number,
    grading_company: grader,
    owner_email: user.email,
    attempted_at: new Date().toISOString(),
  };
  if (res.status === 200) {
    const b = res.body || {};
    const { error } = await db.from('gtcr_registrations').insert({
      ...base,
      status: 'registered',
      gtcr_status: b.status === 'already_registered' ? 'already_registered' : 'registered',
      gtcr_registration_id: b.registration_id || null,
      gtcr_registration_number: b.gtcr_registration_number || null,
      seller_linked: typeof b.seller_linked === 'boolean' ? b.seller_linked : null,
    });
    if (error) console.warn('[gtcr-registry] registration log insert failed:', error.message);
    return { ok: true, unlinked: b.seller_linked === false };
  }
  const error = `${res.status}: ${res.body?.error || res.text.slice(0, 200)}`;
  // 401 is our key, not this card; don't mark the card as failed for that.
  if (res.status !== 401) {
    await db.from('gtcr_registrations').insert({ ...base, status: 'failed', gtcr_error: error });
  }
  return { ok: false, status: res.status, error };
}

async function reconcile(db, user) {
  const started = Date.now();
  const consent = await latestConsent(db, user.id);
  const consented = consentIsCurrent(consent);
  const canRegister = consented && REGISTRATION_ENABLED();

  const inventory = await loadInventory(db, user.id);
  const invById = new Map(inventory.map(c => [c.id, c]));

  // Cards that should be registered: owned (not sold), graded with a cert #,
  // and without a stolen/lost flag or a seller dispute. Keyed by slab so the
  // same slab entered twice is only registered once.
  const desiredByKey = new Map();
  if (consented) {
    for (const c of inventory) {
      const cert = String(c.cert_number || '').trim();
      const grader = toGtcrGrader(c.grader);
      if (!cert || !grader || c.status === 'Sold') continue;
      if (c.trust_flag === 'flagged' || c.trust_flag === 'disputed') continue;
      if (!describe(c)) continue;
      const k = certKey(cert, grader);
      if (!desiredByKey.has(k)) desiredByKey.set(k, { card: c, grader });
    }
  }

  const { data: regRows } = await db.from('gtcr_registrations')
    .select('id, inventory_id, cert_number, grading_company, owner_email, status, attempted_at')
    .eq('seller_id', user.id).in('status', ['registered', 'failed']);
  const active = (regRows || []).filter(r => r.status === 'registered');
  const activeKeys = new Set(active.map(r => certKey(r.cert_number, r.grading_company)));
  const recentFailures = new Set((regRows || [])
    .filter(r => r.status === 'failed' && r.attempted_at && Date.now() - new Date(r.attempted_at).getTime() < FAILED_RETRY_MS)
    .map(r => `${r.inventory_id}|${certKey(r.cert_number, r.grading_company)}`));

  const toRemove = [];
  for (const r of active) {
    const reason = removalReason(r, invById, desiredByKey, consented);
    if (reason) { toRemove.push({ reg: r, reason }); continue; }
    // Same slab now lives on a different inventory row (deleted and re-added): relink.
    const want = desiredByKey.get(certKey(r.cert_number, r.grading_company));
    if (want && want.card.id !== r.inventory_id) {
      await db.from('gtcr_registrations').update({ inventory_id: want.card.id }).eq('id', r.id);
    }
  }
  let toRegister = !canRegister ? [] : [...desiredByKey.entries()]
    .filter(([k, w]) => !activeKeys.has(k) && !recentFailures.has(`${w.card.id}|${k}`))
    .map(([, w]) => w);
  // Only register cards with a recent clean Trust Check. The others wait until
  // the app re-checks them; they are not counted as remaining.
  let awaitingCheck = 0;
  if (toRegister.length) {
    const checked = await cleanRecentlyChecked(db, toRegister.map(w => w.card));
    awaitingCheck = toRegister.filter(w => !checked.has(w.card.id)).length;
    toRegister = toRegister.filter(w => checked.has(w.card.id));
  }

  let sellerName = null;
  if (toRegister.length) {
    const { data: seller } = await db.from('sellers').select('display_name').eq('id', user.id).maybeSingle();
    sellerName = seller?.display_name || null;
  }

  let registered = 0, removed = 0, failed = 0, unlinked = false, authError = false, done = 0;
  const outOfTime = () => Date.now() - started > RECONCILE_BUDGET_MS;

  for (const { reg, reason } of toRemove) {
    if (outOfTime() || authError) break;
    done++;
    try {
      const r = await removeOne(db, user, reg, reason);
      if (r.ok) removed++;
      else { failed++; if (r.status === 401) authError = true; console.warn('[gtcr-registry] remove non-ok:', r.status, r.error); }
    } catch (err) { failed++; console.warn('[gtcr-registry] remove failed:', err.message); }
  }
  for (const w of toRegister) {
    if (outOfTime() || authError) break;
    done++;
    try {
      const r = await registerOne(db, user, w.card, w.grader, consent, sellerName);
      if (r.ok) { registered++; if (r.unlinked) unlinked = true; }
      else { failed++; if (r.status === 401) authError = true; console.warn('[gtcr-registry] register non-ok:', r.error); }
    } catch (err) { failed++; console.warn('[gtcr-registry] register failed:', err.message); }
  }

  if (authError) console.error('[gtcr-registry] GTCR rejected the write key (401). Check GTCR_WRITE_API_KEY.');
  return {
    registered, removed, failed, unlinked,
    awaiting_check: awaitingCheck,
    auth_error: authError,
    remaining: Math.max(0, toRemove.length + toRegister.length - done),
  };
}

async function handleRevoke(db, user, event, input) {
  const copyVersion = String(input.consent_copy_version || '').trim() || 'unknown';
  const current = await latestConsent(db, user.id);
  if (current?.action === 'granted') {
    await recordConsentEvent(db, user, event, 'revoked', copyVersion);
  }
  const result = await reconcile(db, user);
  return json(200, { success: true, consented: false, ...result });
}

async function handleReconcile(db, user) {
  if (!process.env.GTCR_WRITE_API_KEY) return json(200, { success: false, error: 'missing_write_key' });
  return json(200, { success: true, ...(await reconcile(db, user)) });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'POST only' });
  let input;
  try { input = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { success: false, error: 'bad json' }); }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(503, { success: false, error: 'persistence_unavailable' });
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const token = (header(event, 'authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const { data: auth } = token ? await db.auth.getUser(token) : { data: null };
  const user = auth?.user;
  if (!user || !user.email) return json(401, { success: false, error: 'unauthorized' });

  try {
    switch (input.action) {
      case 'status':         return await handleStatus(db, user);
      case 'grant':          return await handleGrant(db, user, event, input);
      case 'revoke':         return await handleRevoke(db, user, event, input);
      case 'reconcile':
      case 'drain_removals':
      case 'register':       return await handleReconcile(db, user);
      default:               return json(400, { success: false, error: 'unknown action' });
    }
  } catch (err) {
    console.error('[gtcr-registry] error:', err.message);
    return json(500, { success: false, error: 'internal' });
  }
};
