// gtcr-trust-check.js — GTCR (Global Trading Card Registry) Trust Check
//
// Read-only side of the GTCR integration (Phase 1 of "Trust Check via GTCR" in
// CLAUDE.md). Uses the READ-ONLY key only (GTCR_READ_API_KEY). The partner write
// key lives exclusively in gtcr-registry.js; do not use it here.
//
// POST { action: 'check', cert_number, grading_company?, inventory_id?, trigger? }
//   → { success, matched, active_count, has_stolen_report, has_lost_report,
//       has_dispute_report, trust_flag }
//   Calls trustCheckApi with partner_id. When a match is found, GTCR logs a
//   PARTNER_LOOKUP event and notifies the original owner by itself. CardShow
//   does not make a separate report call.
//   When inventory_id + a valid seller JWT are supplied, also (service key):
//     - logs a cert_trust_checks row
//     - on a match: sets inventory.trust_flag = 'flagged' (unless the seller
//       already disputed) and deletes that card's show_inventory rows, which
//       blocks publishing and hides it from buyers
//     - on no match: clears a stale 'flagged' (the report was closed)
//   Any GTCR failure returns { success: false }. The client treats that as
//   FAIL OPEN: no flag, and it re-checks on the next publish.
//
// POST { action: 'resolve', inventory_id, resolution: 'removed'|'disputed', note? }
//   Records the seller's decision on a flagged card. 'disputed' sets
//   trust_flag = 'disputed' (publishing allowed again). For 'removed' the client
//   deletes the card afterwards; this call only writes the audit row, which
//   survives the delete (ON DELETE SET NULL).
//
// Both actions require `Authorization: Bearer <supabase access token>`, except
// that 'check' without inventory_id is a bare lookup (no persistence).
//
// Env: GTCR_READ_API_KEY (required), GTCR_API_BASE (default
// https://thegtcr.com/functions), GTCR_PARTNER_ID (default 'cardshow', pending
// confirmation with GTCR), SUPABASE_URL + SUPABASE_SERVICE_KEY (for persistence).

const { createClient } = require('@supabase/supabase-js');

const GTCR_API_BASE   = (process.env.GTCR_API_BASE || 'https://thegtcr.com/functions').replace(/\/+$/, '');
const GTCR_PARTNER_ID = process.env.GTCR_PARTNER_ID || 'cardshow';
const GTCR_TIMEOUT_MS = 5000;

// Duplicated in gtcr-registry.js (no shared module in this no-build-step repo).
// GTCR's grading_company enum: PSA, BGS, CGC, SGC, HGA, TAG, AGS, C3G, DGA, Other.
const GTCR_GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'HGA', 'TAG', 'AGS', 'C3G', 'DGA'];
function toGtcrGrader(g) {
  const up = String(g || '').trim().toUpperCase();
  if (!up) return null;
  return GTCR_GRADERS.includes(up) ? up : 'Other';
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function getDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(db, event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!db || !token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// Pulls the confirmed response fields defensively. GTCR documents
// `reports.active_count` plus the three has_*_report booleans; the booleans are
// read from either `reports.*` or the top level, since only a partial schema
// has been shared.
// Diagnostic only: the response's structure with string values redacted to
// their length, so field names can be checked against what the parser reads.
// Numbers and booleans pass through. Strings pass through only under
// enum-like keys (type/status/...), which is where "stolen" vs "lost" lives;
// free text such as names or notes stays redacted.
const SHAPE_VISIBLE_KEYS = /^(type|status|kind|state|category|report_type|report_status|reason|card_status|verification_level|grading_company|grade)$/i;
function describeShape(v, depth = 0, key = '') {
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.length ? [describeShape(v[0], depth + 1, key), `(${v.length} items)`] : [];
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = describeShape(v[k], depth + 1, k);
    return out;
  }
  if (typeof v === 'string') return SHAPE_VISIBLE_KEYS.test(key) && v.length <= 40 ? v : `<string len ${v.length}>`;
  return v;
}

function normalizeTrustResponse(body) {
  const b = body || {};
  const reports = b.reports || b.data?.reports || {};
  const pick = (k) => reports[k] ?? b[k] ?? b.data?.[k];
  const activeCount = Number(pick('active_count') ?? 0) || 0;
  // GTCR's has_*_report booleans come back false even for a cert with an
  // active stolen report (confirmed live with a known-stolen test cert). The
  // real signal is card_status, e.g. 'REPORTED_STOLEN' / 'UNREGISTERED'. Read
  // it first and keep the booleans as a fallback in case GTCR starts filling them.
  const cardStatus = String(b.card_status ?? b.data?.card_status ?? '').toUpperCase() || null;
  const hasStolen  = !!pick('has_stolen_report')  || /STOLEN/.test(cardStatus || '');
  const hasLost    = !!pick('has_lost_report')    || /LOST|MISSING/.test(cardStatus || '');
  const hasDispute = !!pick('has_dispute_report') || /DISPUT/.test(cardStatus || '');
  return {
    card_status:        cardStatus,
    found:              b.found ?? null,
    active_count:       activeCount,
    has_stolen_report:  hasStolen,
    has_lost_report:    hasLost,
    has_dispute_report: hasDispute,
    // A match is an active stolen/lost report. A dispute report on its own is
    // stored but does not flag the listing. active_count also counts open
    // disputes (GTCR, 2026-09-25), so it only decides a match when there is no
    // card_status to go on.
    matched: hasStolen || hasLost || (!cardStatus && activeCount > 0 && !hasDispute),
  };
}

async function callTrustCheck(certNumber, gradingCompany) {
  const key = process.env.GTCR_READ_API_KEY;
  if (!key) throw Object.assign(new Error('GTCR_READ_API_KEY not set'), { reason: 'missing_read_key' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GTCR_TIMEOUT_MS);
  try {
    const payload = { cert_number: certNumber, partner_id: GTCR_PARTNER_ID };
    if (gradingCompany) payload.grading_company = gradingCompany;
    const res = await fetch(`${GTCR_API_BASE}/trustCheckApi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gtcr-api-key': key },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      throw Object.assign(new Error(`trustCheckApi ${res.status}: ${text.slice(0, 200)}`),
        { reason: `gtcr_http_${res.status}`, gtcrMessage: (body && (body.error || body.message)) || null });
    }
    return Object.defineProperty(normalizeTrustResponse(body), '_raw', { value: body, enumerable: false });
  } finally {
    clearTimeout(timer);
  }
}

async function handleCheck(db, event, input) {
  const certNumber = String(input.cert_number || '').trim();
  if (!certNumber) return json(400, { success: false, error: 'cert_number required' });
  const gradingCompany = toGtcrGrader(input.grading_company);

  let result;
  try {
    result = await callTrustCheck(certNumber, gradingCompany);
  } catch (err) {
    console.warn('[gtcr-trust-check] lookup failed (client fails open):', err.message);
    // `reason` / `gtcr_message` are diagnostic only. They carry no key material,
    // just which step failed: missing key, a GTCR HTTP status, a timeout, or a
    // network error.
    return json(200, {
      success: false,
      error: 'lookup_failed',
      reason: err.reason || (err.name === 'AbortError' ? 'timeout' : 'network_error'),
      gtcr_message: err.gtcrMessage || null,
    });
  }

  let trustFlag;
  if (input.inventory_id && db) {
    const user = await getUser(db, event);
    if (user) {
      const { data: row } = await db.from('inventory')
        .select('id, seller_id, trust_flag').eq('id', input.inventory_id).maybeSingle();
      if (row && row.seller_id === user.id) {
        await db.from('cert_trust_checks').insert({
          inventory_id: row.id,
          seller_id: user.id,
          cert_number: certNumber,
          grading_company: gradingCompany,
          source: 'gtcr',
          trigger: input.trigger === 'publish' ? 'publish' : 'insert',
          matched: result.matched,
          active_count: result.active_count,
          has_stolen_report: result.has_stolen_report,
          has_lost_report: result.has_lost_report,
          has_dispute_report: result.has_dispute_report,
        }).then(({ error }) => { if (error) console.warn('[gtcr-trust-check] log insert failed:', error.message); });

        trustFlag = row.trust_flag || null;
        if (result.matched && trustFlag !== 'disputed') {
          trustFlag = 'flagged';
          const { error: flagErr } = await db.from('inventory').update({ trust_flag: 'flagged' }).eq('id', row.id);
          if (flagErr) console.warn('[gtcr-trust-check] flag update failed:', flagErr.message);
          const { error: unpubErr } = await db.from('show_inventory').delete().eq('card_id', row.id);
          if (unpubErr) console.warn('[gtcr-trust-check] unpublish failed:', unpubErr.message);
        } else if (!result.matched && trustFlag === 'flagged') {
          trustFlag = null;
          await db.from('inventory').update({ trust_flag: null }).eq('id', row.id);
        }
      }
    }
  }

  const payload = { success: true, ...result, trust_flag: trustFlag };
  if (input.debug === true) payload.response_shape = describeShape(result._raw);
  return json(200, payload);
}

async function handleResolve(db, event, input) {
  if (!db) return json(503, { success: false, error: 'persistence_unavailable' });
  const user = await getUser(db, event);
  if (!user) return json(401, { success: false, error: 'unauthorized' });
  const resolution = input.resolution;
  if (!['removed', 'disputed'].includes(resolution)) return json(400, { success: false, error: 'bad resolution' });

  const { data: row } = await db.from('inventory')
    .select('id, seller_id').eq('id', input.inventory_id || '').maybeSingle();
  if (!row || row.seller_id !== user.id) return json(404, { success: false, error: 'not_found' });

  const note = String(input.note || '').slice(0, 1000) || null;
  const { data: latest } = await db.from('cert_trust_checks')
    .select('id').eq('inventory_id', row.id).eq('matched', true)
    .order('checked_at', { ascending: false }).limit(1).maybeSingle();
  if (latest) {
    await db.from('cert_trust_checks').update({
      seller_action: resolution, seller_action_at: new Date().toISOString(), seller_action_note: note,
    }).eq('id', latest.id);
  }
  if (resolution === 'disputed') {
    const { error } = await db.from('inventory').update({ trust_flag: 'disputed' }).eq('id', row.id);
    if (error) return json(500, { success: false, error: error.message });
  }
  return json(200, { success: true, trust_flag: resolution === 'disputed' ? 'disputed' : 'flagged' });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'POST only' });
  let input;
  try { input = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { success: false, error: 'bad json' }); }
  const db = getDb();
  try {
    if (input.action === 'resolve') return await handleResolve(db, event, input);
    return await handleCheck(db, event, input);
  } catch (err) {
    console.error('[gtcr-trust-check] error:', err.message);
    return json(200, { success: false, error: 'internal' });
  }
};
