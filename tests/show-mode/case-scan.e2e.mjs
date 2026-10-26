// Show Mode Phase 3 — case scan (screens A–D). Run like show-mode.e2e.mjs:
//   node case-scan.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block', permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
await ctx.route('**/.netlify/functions/comp-lookup', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ compPrice: 110 }] }) }));
await ctx.route('**/.netlify/functions/gtcr-*', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/.netlify/functions/scan-card', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true,
  card: { player_name: 'Mike Trout', year: 2011, set_name: 'Topps Update', card_number: 'US175', confidence: { player_name: 0.95, year: 0.9, set_name: 0.9 } } }) }));

// bulk-scan answers, one per request in order. 'fail' = HTTP 503, 'hang' = slow.
const card = (player, extra) => Object.assign({ player, year: '2023', set: 'topps chrome', cardNumber: '1', parallel: 'base', grade: '', grader: '', certNumber: '', confidence: 'high', notes: '', box: [0.05, 0.05, 0.28, 0.4] }, extra);
let bulkQueue = [
  { cards: [card('dylan crews', { year: '2024', set: 'bowman chrome', grader: 'psa', grade: '10', certNumber: '12345678' }), card('juan soto', { box: [0.36, 0.05, 0.28, 0.4] })] },
  'fail',
  { cards: [card('mike trout', { confidence: 'medium', year: '2011', set: 'topps update' }), card('', { set: '', year: '', confidence: 'low', notes: 'glare on the slab label', box: null })] },
  { cards: [card('paul skenes', { year: '2024', set: 'topps chrome update' })] },
];
let bulkCalls = 0;
await ctx.route('**/functions/v1/bulk-scan', async r => {
  bulkCalls++;
  const next = bulkQueue.shift();
  if (next === 'fail') return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"api_error","message":"Anthropic API error 529"}' });
  if (next && next.hang) { await new Promise(res => setTimeout(res, next.hang)); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ cards: next.cards, count: next.cards.length }) }).catch(() => {}); }
  const cards = (next && next.cards) || [];
  r.fulfill({ contentType: 'application/json', body: JSON.stringify({ cards, count: cards.length }) });
});
await ctx.route('**/.netlify/functions/cardsight-identify', async r => {
  const body = JSON.parse(r.request().postData() || '{}');
  if (!body.all) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, identified: true,
    detection: { player: 'Mike Trout', year: '2011', cardSet: 'Topps Update', number: 'US175', catalogCardId: 'cat-trout', confidence: 'high', suggestions: [] } }) });
  r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, identified: true,
    detections: [{ player: 'Juan Soto', year: '2023', cardSet: 'Topps Chrome', number: '1', parallel: '', catalogCardId: 'cat-soto', confidence: 'high', suggestions: [] }] }) });
});

const srv = () => page.evaluate(() => window.__srv);
const wait = ms => page.waitForTimeout(ms);
const hash = () => page.evaluate(() => location.hash);
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
async function tapCheck(label) {
  const small = await page.evaluate(() => [...document.querySelectorAll('#showModeRoot button, #showModeRoot input, #showModeRoot select, #showModeRoot summary')]
    .filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden' && b.type !== 'file')
    .map(b => { const r = b.getBoundingClientRect(); return { t: (b.innerText || b.getAttribute('aria-label') || b.id || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => x.w < 44 || x.h < 44));
  check(`tap targets ≥44px · ${label}`, small.length === 0, small.length ? JSON.stringify(small) : '');
}
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-${deviceName.replace(/\s/g, '')}.png` }); };
async function flush() { await page.evaluate(() => smDrain()); await wait(500); }
const photosState = () => page.evaluate(async () => (await smStore.all('scanPhotos')).map(p => ({ id: p.id, batchId: p.batchId, status: p.status, items: p.items.length, error: p.error })));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(250); } return false; }

// ── Pure functions ──
await page.goto(BASE + '/app.html?show_mode=1');
await wait(500);
const unit = await page.evaluate(() => {
  const T = window.__scTest;
  const c = (conf) => ({ fields: { player: 'A' }, confidence: conf });
  const r = {};
  r.highAlone = T.scClassify([c(0.9)]) === 'matched';
  r.belowMin = T.scClassify([c(0.84)]) === 'needs_review';
  r.gapExact = T.scClassify([c(0.95), c(0.85)]) === 'matched';
  r.gapSmall = T.scClassify([c(0.9), c(0.85)]) === 'needs_review';
  r.empty = T.scClassify([{ fields: { player: '', cardSet: '' }, confidence: 0.9 }]) === 'failed';
  r.box = !T.scValidBox([0.1, 0.1, 2, 0.3]) && !!T.scValidBox([0.1, 0.1, 0.3, 0.3]) && !T.scValidBox(null);
  const items = T.scBuildItems(
    [{ player: 'juan soto', year: '2023', set: 'topps chrome', confidence: 'medium' }, { player: 'mike trout', year: '2011', set: 'topps', confidence: 'high' }],
    [{ player: 'Juan Soto', year: '2023', cardSet: 'Topps Chrome Sapphire', number: '7', catalogCardId: 'x', confidence: 'high', suggestions: [] }]);
  r.paired = items[0].candidates[0].confidence === 0.95 && items[0].candidates[0].fields.cardSet === 'Topps Chrome Sapphire' && items[0].state === 'matched';
  r.titleCase = items[1].candidates[0].fields.player === 'Mike Trout';
  r.unpairedGetsNoLeftover = items[1].candidates.length === 1;
  const csOnly = T.scBuildItems([], [{ player: 'Juan Soto', year: '2023', cardSet: 'Topps', confidence: 'medium', suggestions: [] }]);
  r.csOnly = csOnly.length === 1 && csOnly[0].state === 'needs_review';
  r.backoff = T.scBackoffMs(1) === 5000 && T.scBackoffMs(2) === 10000 && T.scBackoffMs(9) === 60000;
  return r;
});
Object.entries(unit).forEach(([k, v]) => check('unit: ' + k, v));

// ── Login → A ──
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(1500);
check('Show Mode opens', await page.locator('#showModeRoot').isVisible());
await page.click('.sm-sec-btn:has-text("Add cards")'); await wait(300);
await page.click('#smAddBackdrop .sm-choice:has-text("A whole case")'); await wait(1200);
check('Add cards → A whole case → case camera', (await hash()).endsWith('/add/scan'));
check('camera running', await page.evaluate(() => { const v = document.getElementById('smVideo'); return !!(v && v.videoWidth); }));
check('Done disabled before any photo', await page.isDisabled('#scDoneBtn'));
await tapCheck('A: scan your case');

const fixture = await page.screenshot({ type: 'jpeg', quality: 60 });
await page.click('#scShutter'); await wait(600);
await page.click('#scShutter'); await wait(600);
await page.setInputFiles('#scFileInput', [{ name: 'case3.jpg', mimeType: 'image/jpeg', buffer: fixture }]);
await wait(800);
check('tray shows 3 photos', (await page.locator('.sc-tray-thumb').count()) === 3);
check('Done · 3', (await page.textContent('#scDoneBtn')).trim() === 'Done · 3');
check('no ready toast while still taking photos', (await page.locator('#smUndoToast').count()) === 0);
await shot('A');
let ph = await photosState();
check('photos saved on the device first', ph.length === 3);
await page.click('#scDoneBtn'); await wait(500);
check('Done → batch screen', /\/add\/batches\/[^/]+$/.test(await hash()));
const batchId = (await hash()).split('/').pop();
await waitFor(async () => (await photosState()).filter(p => p.status === 'done' || p.status === 'waiting').length === 3);
ph = await photosState();
check('photo 2 hit a server error and waits to retry', ph.filter(p => p.status === 'waiting').length === 1 && ph.filter(p => p.status === 'done').length === 2, JSON.stringify(ph));
check('B shows Retry now', (await page.locator('.sm-row-btn:has-text("Retry now")').count()) === 1);
check('B review button enabled while one photo waits', !(await page.isDisabled('.sm-primary')));
check('B has a progressbar', (await page.locator('[role=progressbar]').count()) === 1);
await tapCheck('B: batch');
await shot('B');
await page.click('.sm-row-btn:has-text("Retry now")');
await waitFor(async () => (await photosState()).every(p => p.status === 'done'));
ph = await photosState();
check('retry succeeds; all 3 photos done', ph.every(p => p.status === 'done') && bulkCalls === 4, `calls=${bulkCalls}`);
await wait(1500);   // comps

// ── C ──
await page.click('.sm-primary:has-text("Review")'); await wait(500);
check('review screen', (await hash()).endsWith('/review'));
const needsCount = await page.locator('.sc-needs').count();
const matchCount = await page.locator('.sc-match').count();
check('needs a look: Trout (medium) + unreadable', needsCount === 2, `needs=${needsCount}`);
check('matched: Crews (existing), Soto, Skenes', matchCount === 3, `matched=${matchCount}`);
check('unreadable shows the glare note', (await page.textContent('.sm-list')).toLowerCase().includes('glare'));
check('Crews labelled already in your case', (await page.textContent('#smView')).includes('Already in your case'));
check('prices filled from comps', (await page.inputValue('.sc-match:has-text("Juan Soto") [data-sc-price]')) === '110');
await tapCheck('C: review');
await shot('C');

// ── D: pick for Trout ──
await page.click('.sc-needs:has-text("Mike Trout") .sm-row-btn'); await wait(400);
check('fix screen', /\/items\//.test(await hash()));
check('D shows candidate tiles', (await page.locator('.sc-tile').count()) >= 2);
await tapCheck('D: fix');
await shot('D');
await page.click('.sc-tile >> nth=0'); await wait(150);
await page.click('.sm-primary:has-text("Use this match")'); await wait(600);
check('Trout moved to matched', (await page.locator('.sc-match:has-text("Mike Trout")').count()) === 1 && (await page.locator('.sc-needs').count()) === 1);

// uncheck Skenes, edit Soto's price
await page.click('.sc-match:has-text("Paul Skenes") .sc-check input'); await wait(200);
await page.fill('.sc-match:has-text("Juan Soto") [data-sc-price]', '95'); await wait(200);
check('commit button counts checked cards', (await page.textContent('#scCommitBtn')).includes('Add 3 to case'));
const invBefore = (await srv()).inventory.length;
await page.click('#scCommitBtn'); await wait(800);
check('commit → inventory screen', (await hash()).endsWith('/inventory'));
await flush(); await flush();
let s = await srv();
const soto = s.inventory.filter(r => r.player === 'Juan Soto');
const trout = s.inventory.filter(r => r.player === 'Mike Trout');
check('Soto + Trout added (Available, source case_scan)', soto.length === 1 && trout.length === 1 && soto[0].status === 'Available' && soto[0].source === 'case_scan', JSON.stringify(soto));
check('edited price kept ($95)', soto[0] && soto[0].price === 95);
check('Skenes (unchecked) not added; unreadable not added', !s.inventory.some(r => r.player === 'Paul Skenes') && s.inventory.length === invBefore + 2);
check('no duplicate for the cert match', s.inventory.filter(r => r.player === 'Dylan Crews').length === 1);
check('new cards live on the show', s.show_inventory.some(r => r.card_id === soto[0].id && r.show_id === 'show_a'));
check('crop captures attached (Soto + Crews linked to c1)', s.card_captures.some(c => c.inventory_id === soto[0].id && c.status === 'attached' && c.entry_point === 'case_scan')
  && s.card_captures.some(c => c.inventory_id === 'c1' && c.status === 'attached'), `caps=${s.card_captures.length}`);
check('crop photos uploaded', s.storage.filter(k => k.endsWith('/crop.jpg')).length >= 2);

// commit again → no duplicates
await page.evaluate(id => smGo('/add/batches/' + id + '/review'), batchId); await wait(400);
check('re-review: 1 needs a look, Skenes still there unchecked', (await page.locator('.sc-needs').count()) === 1 && (await page.locator('.sc-match.sc-off:has-text("Paul Skenes")').count()) === 1);
await page.evaluate(id => scCommit(id), batchId); await wait(600); await flush();
s = await srv();
check('second commit adds nothing', s.inventory.length === invBefore + 2);

// home banner for the unfinished batch
await page.evaluate(() => smGoHome()); await wait(400);
check('home shows the case scan banner', (await page.locator('.sc-home-banner').count()) >= 1);
await shot('home');

// ── Resume after the app closes mid-photo ──
bulkQueue = [{ hang: 2500, cards: [card('lost request')] }, { cards: [card('ken griffey jr', { year: '1989', set: 'upper deck' })] }];
await page.evaluate(() => smGo('/add/scan')); await wait(800);
await page.setInputFiles('#scFileInput', [{ name: 'case4.jpg', mimeType: 'image/jpeg', buffer: fixture }]);
await wait(600);
ph = await photosState();
check('photo working when the app closes', ph.some(p => p.status === 'working'));
await page.reload(); await wait(2500);
await waitFor(async () => (await photosState()).every(p => p.status === 'done'));
ph = await photosState();
const g = await page.evaluate(async () => (await smStore.all('scanPhotos')).flatMap(p => p.items).some(i => i.candidates[0].fields.player === 'Ken Griffey Jr'));
check('resumes after reload and finishes', ph.every(p => p.status === 'done') && g, JSON.stringify(ph));

// ── Offline photo waits for signal ──
bulkQueue = [{ cards: [card('cal ripken', { year: '1982', set: 'topps traded' })] }];
await page.evaluate(() => smGo('/add/scan')); await wait(800);
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await page.setInputFiles('#scFileInput', [{ name: 'case5.jpg', mimeType: 'image/jpeg', buffer: fixture }]);
await wait(600);
await page.click('#scDoneBtn'); await wait(800);
check('offline photo shows Waiting for signal', (await page.textContent('#smView')).includes('Waiting for signal'));
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await waitFor(async () => (await photosState()).every(p => p.status === 'done'));
check('back online → photo done', (await photosState()).every(p => p.status === 'done'));

console.log('errors:', JSON.stringify(errors.filter(e => !/favicon|Failed to load resource/.test(e))));
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
