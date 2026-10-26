// Round-trip test of GTCR's write endpoints with a fake cert, as GTCR suggested.
// Registers a TEST cert, registers it again (expects already_registered),
// removes it (expects removed), removes it again (expects 404 not_found).
// GTCR soft-deletes, so the test record stays in their audit log as Removed
// but never counts as an active registration or affects Trust Checks.
//
// Run locally or in a trusted shell. Never commit or paste the key:
//   GTCR_WRITE_API_KEY=... node scripts/gtcr-write-roundtrip.js
// Optional: GTCR_API_BASE (default https://thegtcr.com/functions),
//           GTCR_TEST_EMAIL (default gtcr-test@getcardshow.com),
//           GTCR_TEST_GRADER (default PSA; try "BGS" to check the Beckett value).

const BASE   = (process.env.GTCR_API_BASE || 'https://thegtcr.com/functions').replace(/\/+$/, '');
const KEY    = process.env.GTCR_WRITE_API_KEY;
const EMAIL  = process.env.GTCR_TEST_EMAIL || 'gtcr-test@getcardshow.com';
const GRADER = process.env.GTCR_TEST_GRADER || 'PSA';
const CERT   = `TEST-CARDSHOW-${Date.now()}`;

if (!KEY) { console.error('Set GTCR_WRITE_API_KEY first.'); process.exit(1); }

async function call(fn, body) {
  const res = await fetch(`${BASE}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-gtcr-api-key': KEY },
    body: JSON.stringify({ ...body, partner_id: 'cardshow' }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, json };
}

function check(label, cond, got) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) console.log('      got:', JSON.stringify(got));
  return cond;
}

(async () => {
  console.log(`Testing ${BASE} with cert ${CERT} (${GRADER}), email ${EMAIL}\n`);
  const reg = {
    cert_number: CERT, grading_company: GRADER, card_description: 'CardShow write-path test card',
    grade: '10', seller_email: EMAIL, seller_name: 'CardShow Test', seller_consent: true,
    consent_timestamp: new Date().toISOString(),
  };
  let ok = true;
  const r1 = await call('registerCardApi', reg);
  if (r1.status === 401) { console.log('FAIL  GTCR rejected the key (401). Check GTCR_WRITE_API_KEY.'); process.exit(1); }
  ok = check('register → 200 registered', r1.status === 200 && r1.json.status === 'registered', r1) && ok;
  const r2 = await call('registerCardApi', reg);
  ok = check('register again → 200 already_registered', r2.status === 200 && r2.json.status === 'already_registered', r2) && ok;
  const r3 = await call('removeRegistrationApi', { cert_number: CERT, grading_company: GRADER, seller_email: 'someone-else@example.com', reason: 'cardshow_test' });
  ok = check('remove with a different email → 404 (can\'t remove another owner\'s)', r3.status === 404, r3) && ok;
  const r4 = await call('removeRegistrationApi', { cert_number: CERT, grading_company: GRADER, seller_email: EMAIL, reason: 'cardshow_test' });
  ok = check('remove → 200 removed', r4.status === 200 && r4.json.status === 'removed', r4) && ok;
  const r5 = await call('removeRegistrationApi', { cert_number: CERT, grading_company: GRADER, seller_email: EMAIL, reason: 'cardshow_test' });
  ok = check('remove again → 404 not_found', r5.status === 404, r5) && ok;
  const r6 = await call('registerCardApi', { ...reg, seller_consent: false });
  ok = check('register without consent → 403', r6.status === 403, r6) && ok;
  console.log(ok ? '\nAll checks passed.' : '\nSome checks failed. See above.');
  process.exit(ok ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
