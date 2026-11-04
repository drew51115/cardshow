// Show Mode — Add cards sheet: one card, type it in, spreadsheet. Run like
// show-mode.e2e.mjs:  node add-cards.e2e.mjs "iPhone 13"
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
let scan = 'ohtani';
const SCANS = {
  crews: { claude: { player_name: 'Dylan Crews', year: 2024, set_name: 'Bowman Chrome', card_number: 'BCP-1', grading_company: 'PSA', grade: '10', cert_number: '12345678', confidence: { player_name: 0.95, year: 0.9, set_name: 0.9 } },
           cs: { player: 'Dylan Crews', year: '2024', cardSet: 'Bowman Chrome Prospects', number: 'BCP-1', catalogCardId: 'cat-1', confidence: 'high', suggestions: [] } },
  ohtani: { claude: { player_name: 'Shohei Ohtani', year: 2018, set_name: 'Topps Update', card_number: 'US1', confidence: { player_name: 0.9, year: 0.9, set_name: 0.8 } },
            cs: { player: 'Shohei Ohtani', year: '2018', cardSet: 'Topps Update', number: 'US1', catalogCardId: 'cat-2', confidence: 'high',
                  suggestions: [{ player: 'Shohei Ohtani', year: '2018', cardSet: 'Topps Chrome Update', number: 'HMT1' }] } },
  skenes: { claude: { player_name: 'Paul Skenes', year: 2024, set_name: 'Topps Chrome', card_number: '1', confidence: { player_name: 0.9, year: 0.9, set_name: 0.9 } },
            cs: { player: 'Paul Skenes', year: '2024', cardSet: 'Topps Chrome', number: '1', catalogCardId: 'cat-3', confidence: 'high', suggestions: [] } },
};
await ctx.route('**/.netlify/functions/scan-card', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, card: SCANS[scan].claude }) }));
await ctx.route('**/.netlify/functions/cardsight-identify', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, identified: true, detection: SCANS[scan].cs }) }));
await ctx.route('**/.netlify/functions/comp-lookup', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ compPrice: 110 }] }) }));
await ctx.route('**/.netlify/functions/gtcr-*', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));

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
async function flush() { await page.evaluate(() => smDrain()); await wait(500); }

await page.goto(BASE + '/app.html?show_mode=1');
await wait(500);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(1500);

// ── The sheet ──
await page.click('.sm-sec-btn:has-text("Add cards")'); await wait(300);
check('Add cards opens a choice sheet (no camera yet)', await page.isVisible('#smAddBackdrop') && !(await hash()).includes('/add'));
const choices = await page.$$eval('#smAddBackdrop .sm-choice strong', els => els.map(e => e.textContent));
check('sheet offers one card / whole case / type / spreadsheet', JSON.stringify(choices) === '["One card","A whole case","Type it in","Upload a spreadsheet"]', JSON.stringify(choices));
await tapCheck('add sheet');

// ── One card: new card → Add to case ──
await page.click('#smAddBackdrop .sm-choice:has-text("One card")'); await wait(1200);
check('One card → add camera', (await hash()).endsWith('/addone') && !(await page.isVisible('#smAddBackdrop')));
check('camera running, no Scan/Search toggle', await page.evaluate(() => !!document.getElementById('smVideo')?.videoWidth) && !(await page.$('#smSegSearch')));
await tapCheck('add camera');
scan = 'ohtani';
await page.click('#smShutter'); await wait(1600);
check('new card: "New card" + Add to case button', (await page.textContent('#smResultSheet')).includes('New card') && await page.isVisible('#smAddBtn'));
check('price pre-filled from market', (await page.inputValue('#smAddPrice')) === '110');
await tapCheck('add result');
await page.click('.sm-link:has-text("Wrong card?")'); await wait(200);
await page.click('#smCandidates .sm-row--button'); await wait(300);
check('Wrong card? switches to the other match', (await page.textContent('#smResultSheet')).includes('Topps Chrome Update'));
await page.fill('#smAddPrice', '95');
const before = (await srv()).inventory.length;
await page.click('#smAddBtn'); await wait(400); await flush(); await flush();
let s = await srv();
const oh = s.inventory.filter(r => r.player === 'Shohei Ohtani');
check('server: one Available Ohtani at $95', oh.length === 1 && oh[0].status === 'Available' && oh[0].price === 95 && oh[0].card_set === 'Topps Chrome Update' && s.inventory.length === before + 1, JSON.stringify(oh));
check('live on the show', s.show_inventory.some(r => r.card_id === oh[0]?.id && r.show_id === 'show_a'));
check('photo attached as its image', s.card_captures.some(c => c.inventory_id === oh[0]?.id && c.status === 'attached') && oh[0]?.primary_capture_id);
check('ready for the next card (sheet cleared, counter shows 1)', !(await page.textContent('#smResultSheet')).trim() && (await page.textContent('.sm-sell-title')).includes('1 added'));

// ── One card: slab already in the case → no duplicate unless asked ──
scan = 'crews';
await page.click('#smShutter'); await wait(1600);
check('cert match: "Already in your case"', (await page.textContent('#smResultSheet')).includes('Already in your case') && !(await page.$('#smAddBtn')));
await page.click('.sm-primary:has-text("Scan next card")'); await wait(200);
await flush();
check('Scan next adds nothing', (await srv()).inventory.filter(r => r.player === 'Dylan Crews').length === 1);
await page.click('#smShutter'); await wait(1600);
await page.click('.sm-link:has-text("Add another copy")'); await wait(300);
check('Add another copy → Add to case form', await page.isVisible('#smAddBtn'));
await page.click('#smAddBtn'); await wait(300); await flush();
check('another copy added on request', (await srv()).inventory.filter(r => r.player === 'Dylan Crews').length === 2);

// ── Edit details from a scan → type screen pre-filled → back to camera ──
scan = 'skenes';
await page.click('#smShutter'); await wait(1600);
await page.click('.sm-link:has-text("Edit details")'); await wait(400);
check('Edit details → type screen pre-filled', (await hash()).endsWith('/addtype') && (await page.inputValue('#smAT_player')) === 'Paul Skenes' && await page.isVisible('.sm-result-img'));
await tapCheck('type it in');
await page.fill('#smAT_parallel', 'Gold /50'); await page.fill('#smAT_price', '400');
await page.click('#smATBtn'); await wait(800); await flush();
s = await srv();
check('edited card saved with its photo', s.inventory.some(r => r.parallel === 'Gold /50' && r.price === 400 && r.primary_capture_id));
check('back on the camera after adding', (await hash()).endsWith('/addone'));

// ── Type it in from the sheet (no photo) ──
await page.evaluate(() => smGoHome()); await wait(300);
await page.click('.sm-sec-btn:has-text("Add cards")'); await wait(200);
await page.click('#smAddBackdrop .sm-choice:has-text("Type it in")'); await wait(400);
await page.click('#smATBtn'); await wait(200);
check('needs a player or set', (await hash()).endsWith('/addtype') && (await srv()).inventory.filter(r => r.player === 'Ken Griffey Jr').length === 0);
await page.fill('#smAT_player', 'Ken Griffey Jr'); await page.fill('#smAT_year', '1989'); await page.fill('#smAT_cardSet', 'Upper Deck'); await page.fill('#smAT_price', '150');
await page.click('#smATBtn'); await wait(500); await flush();
s = await srv();
check('typed card added, form clears for the next one', s.inventory.some(r => r.player === 'Ken Griffey Jr' && r.price === 150) && (await page.inputValue('#smAT_player')) === '');

// ── Spreadsheet: opens the file picker from the tap ──
await page.evaluate(() => smGoHome()); await wait(300);
await page.click('.sm-sec-btn:has-text("Add cards")'); await wait(200);
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null),
  page.click('#smAddBackdrop .sm-choice:has-text("Upload a spreadsheet")'),
]);
check('Upload a spreadsheet opens the file picker', !!chooser && !(await page.isVisible('#smAddBackdrop')));

// ── Sheet closes on Cancel and on route change ──
await page.click('.sm-sec-btn:has-text("Add cards")'); await wait(200);
await page.click('#smAddBackdrop .sm-sec-btn:has-text("Cancel")'); await wait(200);
check('Cancel closes the sheet', !(await page.isVisible('#smAddBackdrop')));

console.log('errors:', JSON.stringify(errors.filter(e => !/favicon|Failed to load resource/.test(e))));
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
