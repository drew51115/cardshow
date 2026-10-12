// verify-certs-background.js — Social Sale Ingestion, stage 2 (§4).
// Netlify background function.
//
// POST { post_id? } with x-social-pipeline-secret. For each claimed
// 'pending_verify' extraction:
//   1. graded_certs cache → PSA Public API (daily budget in api_budget)
//      Over budget → verify_status 'awaiting_budget'; the hourly sweep retries.
//   2. Non-PSA graders: no cert API wired yet → 'unsupported_grader' (review only).
//   3. Card-match check against the cert record; a different card = misread → review.
//   4. One unknown digit: recover from the cache only.
//   5. GTCR stolen/lost check (flags, never blocks).
// Then hands off to resolve-and-route-background.

const P = require('../lib/social-pipeline');

const BATCH = 25;

exports.handler = async (event) => {
  if (!P.isPipelineCall(event)) return { statusCode: 401 };
  const db = P.getDb();
  if (!db) return { statusCode: 503 };
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { /* empty */ }
  const base = input.base || P.siteBase(event);

  const { data: rows, error } = await db.rpc('claim_social_extractions', {
    p_status: 'pending_verify', p_limit: BATCH, p_post_id: input.post_id || null,
  });
  if (error) { console.error('[social-verify] claim failed:', error.message); return { statusCode: 500 }; }

  let advanced = 0;
  for (const ext of rows || []) {
    try {
      if (await verifyOne(db, ext)) advanced++;
    } catch (err) {
      console.error(`[social-verify] ${ext.id} failed:`, err.message);
      await db.from('social_extractions').update({ claimed_at: null, verify_status: 'error', updated_at: new Date().toISOString() }).eq('id', ext.id);
    }
  }

  if (advanced) await P.kickStage(base, 'resolve-and-route-background', input.post_id ? { post_id: input.post_id } : {});
  // A full batch that made progress: there may be more. (A batch that only hit
  // the budget wall must not re-kick itself, or it would loop all day.)
  if (!input.post_id && advanced && (rows || []).length === BATCH) await P.kickStage(base, 'verify-certs-background', {});
  return { statusCode: 202 };
};

// Returns true when the row moved on to pending_resolve.
async function verifyOne(db, ext) {
  const patch = { claimed_at: null, updated_at: new Date().toISOString() };
  let cert = null;
  let certNumber = ext.cert_number;

  if (!certNumber && ext.cert_partial) {
    const recovered = await P.recoverPartialCert(db, ext);
    if (recovered) {
      certNumber = recovered.cert_number;
      Object.assign(patch, { cert_number: certNumber, cert_recovered: true });
      cert = recovered;
      patch.verify_status = 'verified';
    } else {
      patch.verify_status = 'no_cert';
    }
  } else if (certNumber) {
    const r = await P.lookupCert(db, ext.grader, certNumber);
    if (r.status === 'budget') {
      // Park it; the sweep drains it tomorrow. Status stays pending_verify.
      // claimed_at stays set so this batch's re-kicks skip it for 15 minutes.
      await db.from('social_extractions').update({ ...patch, claimed_at: new Date().toISOString(), verify_status: 'awaiting_budget' }).eq('id', ext.id);
      return false;
    }
    if (r.status === 'error') {
      // Transient (timeout, 5xx, missing token): keep it queued for the sweep,
      // but don't spin forever — after a day, let review handle it unverified.
      const ageH = (Date.now() - new Date(ext.created_at).getTime()) / 3600000;
      if (ageH < 24) {
        await db.from('social_extractions').update({ ...patch, claimed_at: new Date().toISOString(), verify_status: 'error' }).eq('id', ext.id);
        return false;
      }
      patch.verify_status = 'format_only';
    } else if (r.status === 'verified') {
      cert = r.cert;
      patch.verify_status = 'verified';
    } else if (r.status === 'not_found') {
      patch.verify_status = 'not_found';
    } else {
      patch.verify_status = 'unsupported_grader';
    }
  } else {
    patch.verify_status = 'no_cert';
  }

  const reasons = [...(ext.route_reasons || [])];
  if (cert) {
    patch.verified_cert = {
      year: cert.year, brand: cert.brand, card_number: cert.card_number, subject: cert.subject,
      variety: cert.variety, grade: cert.grade, grade_label: cert.grade_label, category: cert.category,
    };
    const match = P.cardMatch(ext, cert);
    patch.card_match_score = match.score;
    if (match.score != null && match.score < 0.6) reasons.push('cert_card_mismatch');
    else if (match.mismatched.length) reasons.push(`field_mismatch:${match.mismatched.join(',')}`);
  }
  if (patch.verify_status === 'not_found') reasons.push('cert_not_found');
  if (patch.verify_status === 'no_cert') reasons.push('cert_unreadable');

  if (certNumber) {
    const stolen = await P.stolenCheck(ext.grader, certNumber);
    if (stolen) {
      patch.stolen_detail = stolen;
      patch.stolen_flag = stolen.flagged;
      if (stolen.flagged) {
        reasons.push('stolen_report');
        console.warn(`[social-verify] ${ext.grader} ${certNumber} has an active ${stolen.stolen ? 'stolen' : 'lost'} report (extraction ${ext.id})`);
      }
    }
  }

  patch.route_reasons = [...new Set(reasons)];
  patch.status = 'pending_resolve';
  await db.from('social_extractions').update(patch).eq('id', ext.id);
  return true;
}
