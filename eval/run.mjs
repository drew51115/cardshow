#!/usr/bin/env node
// Scan accuracy eval — posts every fixture photo to the scan functions and
// reports per-field exact-match rates. See eval/README.md.
//
//   node eval/run.mjs                    # single-card fixtures → scan-card, bulk → bulk-scan
//   node eval/run.mjs --path vision-scan # single-card fixtures through vision-scan instead
//   node eval/run.mjs --only bulk        # just one kind (single | bulk)
//
// Env:
//   FUNCTIONS_URL   default http://localhost:8888/.netlify/functions  (netlify dev)
//   BULK_SCAN_URL   e.g. http://localhost:54321/functions/v1/bulk-scan
//   SUPABASE_JWT    a signed-in seller's access token (bulk-scan requires auth)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const FUNCTIONS_URL = process.env.FUNCTIONS_URL || 'http://localhost:8888/.netlify/functions';
const BULK_SCAN_URL = process.env.BULK_SCAN_URL || '';
const SUPABASE_JWT  = process.env.SUPABASE_JWT || '';

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const SINGLE_PATH = argVal('--path', 'scan-card');
const ONLY = argVal('--only', '');

const FIELDS = ['player', 'year', 'set', 'card_number', 'parallel', 'grader', 'grade', 'cert'];
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// ── Normalization ───────────────────────────────────────
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const normCert = (v) => String(v ?? '').replace(/[\s-]/g, '').toLowerCase();
const normGrade = (v) => { const m = String(v ?? '').match(/\d+(?:\.\d+)?/); return m ? String(parseFloat(m[0])) : norm(v); };
const normGrader = (v) => { const g = norm(v); return g === 'beckett' ? 'bgs' : g; };
const normalizers = { cert: normCert, grade: normGrade, grader: normGrader, card_number: (v) => norm(v).replace(/^#/, '') };
const eq = (f, a, b) => (normalizers[f] || norm)(a) === (normalizers[f] || norm)(b);

// Map each function's response card into the shared field set.
function fromScanCard(c) {
  const parallel = [c.parallel_name, c.autograph && !/\bauto/i.test(c.parallel_name || '') ? 'Auto' : '']
    .filter(Boolean).join(' ');
  return { player: c.player_name, year: c.year, set: c.set_name, card_number: c.card_number,
    parallel, grader: c.grading_company, grade: c.grade, cert: c.cert_number,
    serial_number: c.serial_number, print_run: c.print_run };
}
function fromVision(c) {
  return { player: c.player, year: c.year, set: c.cardSet, card_number: c.cardNumber,
    parallel: c.parallel, grader: c.grader, grade: c.gradeLabel ?? c.grade, cert: c.certNumber,
    serial_number: c.serialNumber, print_run: c.printRun };
}
function fromBulk(c) {
  return { player: c.player, year: c.year, set: c.set, card_number: c.cardNumber,
    parallel: c.parallel, grader: c.grader, grade: c.grade, cert: c.certNumber,
    serial_number: c.serialNumber, print_run: c.printRun };
}

// ── Calls ───────────────────────────────────────────────
async function callSingle(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  const mediaType = MEDIA[path.extname(file).toLowerCase()] || 'image/jpeg';
  const body = SINGLE_PATH === 'vision-scan'
    ? { image: b64, mediaType }
    : { image_base64: b64, media_type: mediaType };
  const t0 = Date.now();
  const res = await fetch(`${FUNCTIONS_URL}/${SINGLE_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!json.success) return { ok: false, ms, error: json.error || res.status, raw: json };
  const card = SINGLE_PATH === 'vision-scan' ? fromVision(json.card) : fromScanCard(json.card);
  return { ok: true, ms, card, flags: json.flags || [], raw: json };
}

async function callBulk(file) {
  if (!BULK_SCAN_URL || !SUPABASE_JWT) throw new Error('BULK_SCAN_URL and SUPABASE_JWT are required for bulk fixtures');
  const size = fs.statSync(file).size;
  if (size > 5 * 1024 * 1024) console.warn(`  ! ${path.basename(file)} is ${(size / 1048576).toFixed(1)}MB — the app uploads a 1568px copy; resize fixtures to match`);
  const fd = new FormData();
  const type = MEDIA[path.extname(file).toLowerCase()] || 'image/jpeg';
  fd.append('image', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  const t0 = Date.now();
  const res = await fetch(BULK_SCAN_URL, { method: 'POST', headers: { Authorization: `Bearer ${SUPABASE_JWT}` }, body: fd });
  const json = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: json.error || res.status, raw: json };
  return { ok: true, ms, cards: (json.cards || []).map(fromBulk), raw: json };
}

// ── Scoring ─────────────────────────────────────────────
function newTally() {
  const t = { n: 0, fields: {}, cert: { correct: 0, wrong: 0, null: 0, invented: 0, n: 0 }, failures: 0, ms: [] };
  FIELDS.forEach(f => { t.fields[f] = { hit: 0, n: 0 }; });
  return t;
}

function scoreCard(tally, expected, got) {
  tally.n++;
  FIELDS.forEach(f => {
    if (f === 'cert') return;
    if (!(f in expected)) return;           // field not labeled for this fixture
    tally.fields[f].n++;
    if (eq(f, expected[f], got?.[f])) tally.fields[f].hit++;
  });
  // Cert scored separately: correct / wrong / null (+ invented on a raw card)
  const exp = normCert(expected.cert), pred = normCert(got?.cert);
  if (exp) {
    tally.cert.n++;
    if (!pred) tally.cert.null++;
    else if (pred === exp) tally.cert.correct++;
    else tally.cert.wrong++;
    tally.fields.cert.n++;
    if (pred === exp) tally.fields.cert.hit++;
  } else if ('cert' in expected && pred) {
    tally.cert.invented++;
  }
}

// Greedy match of predicted bulk cards to expected cards by field agreement.
function matchBulk(expectedCards, gotCards) {
  const pairs = [];
  expectedCards.forEach((e, i) => gotCards.forEach((g, j) => {
    let s = 0;
    if (e.cert && eq('cert', e.cert, g.cert)) s += 5;
    ['player', 'card_number', 'year', 'set', 'parallel', 'grade'].forEach(f => { if (e[f] && eq(f, e[f], g[f])) s++; });
    pairs.push({ i, j, s });
  }));
  pairs.sort((a, b) => b.s - a.s);
  const usedE = new Set(), usedG = new Set(), out = [];
  for (const p of pairs) {
    if (p.s === 0 || usedE.has(p.i) || usedG.has(p.j)) continue;
    usedE.add(p.i); usedG.add(p.j); out.push([expectedCards[p.i], gotCards[p.j]]);
  }
  expectedCards.forEach((e, i) => { if (!usedE.has(i)) out.push([e, null]); });
  return { pairs: out, extra: gotCards.length - usedG.size };
}

const pct = (h, n) => n ? `${(100 * h / n).toFixed(1)}%` : '—';

function printTally(label, t) {
  console.log(`\n${label}  (${t.n} cards, ${t.failures} failed calls, median ${median(t.ms)}ms)`);
  console.log('field         exact   n');
  FIELDS.forEach(f => console.log(`${f.padEnd(12)}  ${pct(t.fields[f].hit, t.fields[f].n).padStart(6)}  ${t.fields[f].n}`));
  const c = t.cert;
  console.log(`cert detail   correct ${c.correct} / wrong ${c.wrong} / null ${c.null}  (of ${c.n})  · invented on raw: ${c.invented}`);
  if (t.extraCards != null) console.log(`bulk: ${t.extraCards} predicted cards matched nothing expected`);
}
function median(a) { if (!a.length) return '—'; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

// ── Main ────────────────────────────────────────────────
const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter(f => IMG_EXT.test(f)).sort() : [];
if (!files.length) {
  console.error(`No fixture photos in ${FIXTURES}. See eval/README.md.`);
  process.exit(1);
}

const single = newTally(), bulk = newTally();
bulk.extraCards = 0;
const results = { startedAt: new Date().toISOString(), singlePath: SINGLE_PATH, fixtures: [] };

for (const f of files) {
  const base = f.replace(IMG_EXT, '');
  const expFile = path.join(FIXTURES, `${base}.expected.json`);
  if (!fs.existsSync(expFile)) { console.warn(`skip ${f}: no ${base}.expected.json`); continue; }
  const expected = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  const kind = expected.type === 'bulk' ? 'bulk' : 'single';
  if (ONLY && ONLY !== kind) continue;
  process.stdout.write(`${kind.padEnd(6)} ${f} … `);

  try {
    if (kind === 'single') {
      const r = await callSingle(path.join(FIXTURES, f));
      single.ms.push(r.ms);
      if (!r.ok) { single.failures++; scoreCard(single, expected.card, null); console.log(`FAIL ${r.error}`); }
      else { scoreCard(single, expected.card, r.card); console.log(`${r.ms}ms${r.flags.length ? ' flags=' + r.flags.join(',') : ''}`); }
      results.fixtures.push({ file: f, kind, expected: expected.card, got: r.card || null, flags: r.flags, error: r.ok ? null : r.error });
    } else {
      const r = await callBulk(path.join(FIXTURES, f));
      bulk.ms.push(r.ms);
      if (!r.ok) {
        bulk.failures++;
        expected.cards.forEach(e => scoreCard(bulk, e, null));
        console.log(`FAIL ${r.error}`);
      } else {
        const { pairs, extra } = matchBulk(expected.cards, r.cards);
        pairs.forEach(([e, g]) => scoreCard(bulk, e, g));
        bulk.extraCards += extra;
        console.log(`${r.ms}ms ${r.cards.length}/${expected.cards.length} cards`);
      }
      results.fixtures.push({ file: f, kind, expected: expected.cards, got: r.cards || null, error: r.ok ? null : r.error });
    }
  } catch (e) {
    console.log(`ERROR ${e.message}`);
    results.fixtures.push({ file: f, kind, error: e.message });
  }
}

if (single.n) printTally(`SINGLE-CARD (${SINGLE_PATH})`, single);
if (bulk.n) printTally('BULK', bulk);

results.summary = { single, bulk };
const out = path.join(here, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
