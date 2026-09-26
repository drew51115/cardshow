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
//   → { success, enabled, consented, consented_at, consent_copy_version, pending_removals }
// POST { action: 'grant', consent_copy_version }
//   Appends a 'granted' consent event (server clock, IP, user-agent). Refused
//   unless GTCR_REGISTRATION_ENABLED === 'true'. The feature stays dark until
//   pricing/packaging is decided.
// POST { action: 'revoke', consent_copy_version }
//   Appends a 'revoked' consent event, then starts draining removals (below).
//   Always allowed, even while the feature is disabled.
// POST { action: 'drain_removals' }
//   Calls removeRegistrationApi for the seller's still-'registered' cards,
//   working within a time budget. Returns { remaining }; the client calls again
//   until it reaches 0. A GTCR 404 counts as success (already removed).
// POST { action: 'register', inventory_id }
//   Registers one sold card. The server loads the card itself and requires:
//   the card belongs to the caller, status = 'Sold', a cert number + grader,
//   and a latest consent event of 'granted'. consent_timestamp is that event's
//   occurred_at, i.e. the moment the toggle was flipped, not now.
//
// Env: GTCR_WRITE_API_KEY, GTCR_REGISTRATION_ENABLED ('true' to allow grant +
// register), GTCR_API_BASE, GTCR_PARTNER_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');

const GTCR_API_BASE    = (process.env.GTCR_API_BASE || 'https://thegtcr.com/functions').replace(/\/+$/, '');
const GTCR_PARTNER_ID  = process.env.GTCR_PARTNER_ID || 'cardshow';
const GTCR_TIMEOUT_MS  = 4000;
const DRAIN_BUDGET_MS  = 7000;   // stay under Netlify's ~10s synchronous ceiling
const REGISTRATION_ENABLED = () => process.env.GTCR_REGISTRATION_ENABLED === 'true';

// Duplicated from gtcr-trust-check.js (no shared module in this repo).
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

async function countActiveRegistrations(db, sellerId) {
  const { count } = await db.from('gtcr_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId).eq('status', 'registered');
  return count || 0;
}

async function handleStatus(db, user) {
  const consent = await latestConsent(db, user.id);
  const consented = consent?.action === 'granted';
  const pending = consented ? 0 : await countActiveRegistrations(db, user.id);
  return json(200, {
    success: true,
    enabled: REGISTRATION_ENABLED(),
    consented,
    consented_at: consented ? consent.occurred_at : null,
    consent_copy_version: consented ? consent.consent_copy_version : null,
    pending_removals: pending,
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
  const current = await latestConsent(db, user.id);
  if (current?.action === 'granted') {
    // Already consented. Keep the original moment instead of overwriting it.
    return json(200, { success: true, consented: true, consented_at: current.occurred_at });
  }
  const ev = await recordConsentEvent(db, user, event, 'granted', copyVersion);
  return json(200, { success: true, consented: true, consented_at: ev.occurred_at });
}

async function drainRemovals(db, user) {
  const started = Date.now();
  const { data: rows } = await db.from('gtcr_registrations')
    .select('id, cert_number, grading_company')
    .eq('seller_id', user.id).eq('status', 'registered')
    .order('registered_at', { ascending: true })
    .limit(50);
  let removed = 0;
  let failed = 0;
  for (const r of rows || []) {
    if (Date.now() - started > DRAIN_BUDGET_MS) break;
    let res;
    try {
      res = await gtcrWrite('removeRegistrationApi', {
        cert_number: r.cert_number,
        grading_company: r.grading_company,
        seller_email: user.email,
        reason: 'seller_consent_revoked',
      });
    } catch (err) {
      console.warn('[gtcr-registry] remove failed:', err.message);
      failed++;
      continue;
    }
    // 200 removed, or 404 not_found (already gone; idempotent), both count as success.
    if (res.status === 200 || res.status === 404) {
      await db.from('gtcr_registrations').update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        remove_reason: 'seller_consent_revoked',
        remove_gtcr_status: res.status === 404 ? 'not_found' : (res.body?.status || 'removed'),
      }).eq('id', r.id);
      removed++;
    } else {
      console.warn('[gtcr-registry] remove non-ok:', res.status, res.text.slice(0, 200));
      failed++;
    }
  }
  const remaining = await countActiveRegistrations(db, user.id);
  return { removed, failed, remaining };
}

async function handleRevoke(db, user, event, input) {
  const copyVersion = String(input.consent_copy_version || '').trim() || 'unknown';
  const current = await latestConsent(db, user.id);
  if (current?.action === 'granted') {
    await recordConsentEvent(db, user, event, 'revoked', copyVersion);
  }
  const result = await drainRemovals(db, user);
  return json(200, { success: true, consented: false, ...result });
}

async function handleDrain(db, user) {
  const current = await latestConsent(db, user.id);
  // Never deregister a seller who is currently consented.
  if (current?.action === 'granted') return json(200, { success: true, removed: 0, failed: 0, remaining: 0 });
  return json(200, { success: true, ...(await drainRemovals(db, user)) });
}

async function handleRegister(db, user, input) {
  if (!REGISTRATION_ENABLED()) return json(403, { success: false, error: 'registration_disabled' });
  const consent = await latestConsent(db, user.id);
  if (consent?.action !== 'granted') return json(403, { success: false, error: 'no_consent' });

  const { data: card } = await db.from('inventory')
    .select('id, seller_id, status, card_title, player, year, card_set, parallel, grader, grade, cert_number')
    .eq('id', input.inventory_id || '').maybeSingle();
  if (!card || card.seller_id !== user.id) return json(404, { success: false, error: 'not_found' });
  if (card.status !== 'Sold') return json(409, { success: false, error: 'not_sold' });
  const certNumber = String(card.cert_number || '').trim();
  const grader = toGtcrGrader(card.grader);
  if (!certNumber || !grader) return json(200, { success: false, error: 'not_graded' });

  const description = (card.card_title
    || [card.year, card.card_set, card.player, card.parallel].filter(Boolean).join(' ')).slice(0, 300);
  if (!description) return json(200, { success: false, error: 'no_description' });

  const { data: seller } = await db.from('sellers').select('display_name').eq('id', user.id).maybeSingle();

  const payload = {
    cert_number: certNumber,
    grading_company: grader,
    card_description: description,
    seller_email: user.email,
    seller_consent: true,
    consent_timestamp: new Date(consent.occurred_at).toISOString(),
  };
  if (card.grade != null) payload.grade = String(card.grade);
  if (seller?.display_name) payload.seller_name = seller.display_name;

  let res;
  try {
    res = await gtcrWrite('registerCardApi', payload);
  } catch (err) {
    console.warn('[gtcr-registry] register failed:', err.message);
    return json(200, { success: false, error: 'register_failed' });
  }
  if (res.status !== 200) {
    console.warn('[gtcr-registry] register non-ok:', res.status, res.text.slice(0, 200));
    return json(200, { success: false, error: `gtcr_${res.status}` });
  }
  const gtcrStatus = res.body?.status === 'already_registered' ? 'already_registered' : 'registered';

  // Upsert-by-hand against the partial unique index (active rows only).
  const { data: existing } = await db.from('gtcr_registrations')
    .select('id').eq('seller_id', user.id).eq('cert_number', certNumber)
    .eq('grading_company', grader).eq('status', 'registered').maybeSingle();
  if (!existing) {
    const { error } = await db.from('gtcr_registrations').insert({
      seller_id: user.id,
      inventory_id: card.id,
      consent_event_id: consent.id,
      cert_number: certNumber,
      grading_company: grader,
      status: 'registered',
      gtcr_status: gtcrStatus,
    });
    if (error) console.warn('[gtcr-registry] registration log insert failed:', error.message);
  }
  return json(200, { success: true, gtcr_status: gtcrStatus });
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
      case 'drain_removals': return await handleDrain(db, user);
      case 'register':       return await handleRegister(db, user, input);
      default:               return json(400, { success: false, error: 'unknown action' });
    }
  } catch (err) {
    console.error('[gtcr-registry] error:', err.message);
    return json(500, { success: false, error: 'internal' });
  }
};
