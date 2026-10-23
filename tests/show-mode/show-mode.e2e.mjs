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
let scan = 'crews';
const SCANS = {
  crews: { claude: { player_name:'Dylan Crews', year:2024, set_name:'Bowman Chrome', card_number:'BCP-1', grading_company:'PSA', grade:'10', cert_number:'12345678', confidence:{player_name:0.95,year:0.9,set_name:0.9} },
           cs: { player:'Dylan Crews', year:'2024', cardSet:'Bowman Chrome Prospects', number:'BCP-1', catalogCardId:'cat-1', confidence:'high', suggestions:[] } },
  ohtani: { claude: { player_name:'Shohei Ohtani', year:2018, set_name:'Topps Update', card_number:'US1', grading_company:null, grade:null, cert_number:null, confidence:{player_name:0.9,year:0.9,set_name:0.8} },
            cs: { player:'Shohei Ohtani', year:'2018', cardSet:'Topps Update', number:'US1', catalogCardId:'cat-2', confidence:'high', suggestions:[] } },
};
await ctx.route('**/.netlify/functions/scan-card', r => r.fulfill({ contentType:'application/json', body: JSON.stringify({ success:true, card: SCANS[scan].claude }) }));
await ctx.route('**/.netlify/functions/cardsight-identify', r => r.fulfill({ contentType:'application/json', body: JSON.stringify({ success:true, identified:true, detection: SCANS[scan].cs }) }));
await ctx.route('**/.netlify/functions/comp-lookup', r => r.fulfill({ contentType:'application/json', body: JSON.stringify({ results:[{ compPrice: 110 }] }) }));
await ctx.route('**/.netlify/functions/gtcr-*', r => r.fulfill({ contentType:'application/json', body: '{"success":false}' }));

const srv = () => page.evaluate(() => window.__srv);
const wait = ms => page.waitForTimeout(ms);
const hash = () => page.evaluate(() => location.hash);
const check = (label, ok, extra='') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`);
async function tapCheck(label) {
  const small = await page.evaluate(() => [...document.querySelectorAll('#showModeRoot button, #showModeRoot input, #showModeRoot select, #showModeRoot summary')]
    .filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden')
    .map(b => { const r = b.getBoundingClientRect(); return { t: (b.innerText || b.getAttribute('aria-label') || b.id || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => x.w < 44 || x.h < 44));
  check(`tap targets ≥44px · ${label}`, small.length === 0, small.length ? JSON.stringify(small) : '');
}
async function flush() { await page.evaluate(() => smDrain()); await wait(400); }

// Login
await page.goto(BASE + '/app.html?show_mode=1');
await wait(500);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(1500);
check('Show Mode opens on login', await page.locator('#showModeRoot').isVisible());
await tapCheck('home');

// ── 1. Inventory row Sell → Confirm (−5%, Venmo) → Mark sold → Undo ──
await page.click('#smBottomNav [data-screen=inventory]'); await wait(300);
check('inventory screen', (await hash()).endsWith('/inventory'));
await tapCheck('inventory');
await page.click('.sm-row:has-text("Dylan Crews") .sm-row-btn');   // tap 1
await wait(300);
check('confirm screen', (await hash()).endsWith('/confirm'));
await tapCheck('confirm');
check('hero price = asking', (await page.textContent('#smHeroPrice')) === '$120');
await page.click('[data-chip=minus5]');                               // tap 2
check('−5% chip → $114', (await page.textContent('#smHeroPrice')) === '$114');
await page.click('[data-pay=Venmo]');                                 // tap 3
await page.click('#smConfirmBtn');                                    // tap 4
await wait(600);
check('sold screen', (await hash()).includes('/sold/'), await hash());
check('Sold! shown', await page.locator('.sm-sold-title').isVisible());
await tapCheck('sold');
let s = await srv();
check('server: inventory c1 sold @114 Venmo', s.inventory.find(r => r.id==='c1').status === 'Sold' && s.inventory.find(r=>r.id==='c1').sold_price === 114 && s.inventory.find(r=>r.id==='c1').payment_method === 'Venmo');
check('server: 1 sale, 1 ledger row with client_sale_id', s.sales.length === 1 && s.show_floor_transactions.length === 1 && !!s.show_floor_transactions[0].client_sale_id);
await page.click('#smUndoToast .sm-toast-btn');
await wait(700);
check('undo returns to confirm with same values', (await hash()).endsWith('/confirm') && (await page.textContent('#smHeroPrice')) === '$114'
  && (await page.getAttribute('[data-pay=Venmo]', 'aria-pressed')) === 'true');
s = await srv();
check('server: c1 Available, sale voided, reversal row', s.inventory.find(r=>r.id==='c1').status === 'Available' && s.sales[0].status === 'voided'
  && s.show_floor_transactions.length === 2 && s.show_floor_transactions[1].sold_price === -114);

// ── 2. Home → Sell → Search → select → Mark sold (defaults) ──
await page.evaluate(() => smGoHome()); await wait(300);
await page.click('.sm-hero'); await wait(500);
check('sell screen (scan default)', (await hash()).endsWith('/sell'));
await page.click('#smSegSearch'); await wait(200);
await page.fill('#smSearchInput', 'elly');
await wait(100);
await tapCheck('search');
await page.click('#smSearchResults .sm-row--button');
await wait(300);
check('search pick → confirm, last payment Venmo preselected', (await page.getAttribute('[data-pay=Venmo]', 'aria-pressed')) === 'true');
await page.click('#smConfirmBtn'); await wait(600);
s = await srv();
check('server: c2 sold @40', s.inventory.find(r=>r.id==='c2').status === 'Sold' && s.inventory.find(r=>r.id==='c2').sold_price === 40);

// ── 3. Offline sale syncs exactly once ──
await page.evaluate(() => smGoHome()); await wait(200);
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c1'); c.Status = 'Available'; });
await ctx.setOffline(true);
await page.evaluate(() => smPickCard('c1', 'inventory_row')); await wait(300);
await page.click('#smConfirmBtn'); await wait(500);
check('offline: sold screen still shown', (await hash()).includes('/sold/'));
await page.evaluate(() => smGoHome()); await wait(300);
check('offline: home shows Syncing', (await page.textContent('#smView')).includes('Syncing'));
const salesBefore = (await srv()).sales.length;
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await wait(1200);
await flush();
s = await srv();
const c1sales = s.sales.filter(x => x.inventory_id === 'c1' && x.status === 'completed');
check('online: exactly one new sale for c1', s.sales.length === salesBefore + 1 && c1sales.length === 1, `sales=${s.sales.length}`);
check('online: Syncing cleared', !(await page.textContent('#smView')).includes('Syncing'));
// replay the same op again → no duplicate
await page.evaluate(async () => { const op = { type:'sale', clientSaleId: inventory.find(c=>c._dbId==='c1')._clientSaleId, cardSnapshot:{}, payload:{ inventoryId:'c1', showId:'show_a', price:120, payment:'Cash', soldDate:'x', soldTime:'y' } }; await _smOpSale(op); });
s = await srv();
check('replayed sale op is a no-op (idempotent)', s.sales.filter(x => x.inventory_id==='c1' && x.status==='completed').length === 1
  && s.show_floor_transactions.filter(t => t.inventory_id==='c1' && t.sold_price > 0).length <= 2);

// ── 4. Scan (fake camera) → slab cert matches inventory → no duplicate ──
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c1'); c.Status = 'Available'; window.__srv.inventory.find(r=>r.id==='c1').status='Available'; });
await page.evaluate(() => smStartSell('nav')); await wait(300);
await page.click('#smSegScan'); await wait(1200);
check('camera running', await page.evaluate(() => { const v = document.getElementById('smVideo'); return !!(v && v.videoWidth); }));
await tapCheck('scan');
scan = 'crews';
await page.click('#smShutter'); await wait(1500);
check('result: In your case (cert match)', (await page.textContent('#smResultSheet')).includes('In your case'));
check('result: Photo saved marker', (await page.textContent('#smResultSheet')).includes('Photo saved'));
await tapCheck('scan result');
const invCountBefore = (await srv()).inventory.length;
await page.click('.sm-sheet-card .sm-primary'); await wait(300);
check('scan → confirm for existing item', (await hash()).endsWith('/confirm') && (await page.textContent('#smConfirmName')) === 'Dylan Crews');
await page.click('#smConfirmBtn'); await wait(800);
await flush(); await wait(500);
s = await srv();
check('no duplicate item created for cert match', s.inventory.length === invCountBefore);
check('capture row synced + attached to c1', s.card_captures.length === 1 && s.card_captures[0].status === 'attached' && s.card_captures[0].inventory_id === 'c1');
check('capture photos uploaded (crop + original)', s.storage.some(k => k.endsWith('/crop.jpg')) && s.storage.some(k => k.endsWith('/original.jpg')));

// ── 5. Manual sale via scan, logged offline → one capture, one item, one sale ──
await page.evaluate(() => smStartManualSale()); await wait(300);
await page.click('#smSegScan'); await wait(1200);
scan = 'ohtani';
await page.click('#smShutter'); await wait(1500);
check('manual: Not in your case', (await page.textContent('#smResultSheet')).includes('Not in your case'));
await page.click('.sm-sheet-card .sm-primary'); await wait(400);
check('manual: confirm shows Log sale + details', (await page.textContent('#smConfirmBtn')).includes('Log sale') && (await page.inputValue('#smNPlayer')) === 'Shohei Ohtani');
check('manual: market price fills asking and selects it', (await page.getAttribute('[data-chip=asking]', 'aria-pressed')) === 'true' && (await page.textContent('#smHeroPrice')) === '$110'); await page.click('[data-chip=other]'); await page.fill('#smOtherPrice', '75'); await page.dispatchEvent('#smOtherPrice', 'input');
await wait(200);
const capsBefore = (await srv()).card_captures.length, salesB = (await srv()).sales.length, invB = (await srv()).inventory.length;
await ctx.setOffline(true);
await page.click('#smConfirmBtn'); await wait(500);
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online'))); await wait(1200); await flush(); await wait(400);
s = await srv();
const oh = s.inventory.filter(r => r.player === 'Shohei Ohtani');
check('manual offline: one item (source manual_sale, Sold)', oh.length === 1 && oh[0].status === 'Sold' && oh[0].source === 'manual_sale' && s.inventory.length === invB + 1);
check('manual offline: one sale, capture attached', s.sales.length === salesB + 1 && s.card_captures.length === capsBefore && s.card_captures.find(c => c.inventory_id === oh[0].id)?.status === 'attached', `caps=${s.card_captures.length}`);
const ohLedger = s.show_floor_transactions.filter(t => t.inventory_id === oh[0].id);
check('manual offline: ledger row source=manual', ohLedger.length === 1 && ohLedger[0].source === 'manual');
// undo the new-item sale → item stays, Available, photo attached
const ohSale = s.sales.find(x => x.inventory_id === oh[0].id);
await page.evaluate(id => smUndoSale(id), ohSale.client_sale_id); await wait(300); await flush();
s = await srv();
check('undo new-item sale: item Available, capture still attached', s.inventory.find(r => r.id === oh[0].id).status === 'Available' && s.card_captures.find(c => c.inventory_id === oh[0].id)?.status === 'attached');

// ── 6. Scan then close → Recent scans → Add to case ──
await page.evaluate(() => smStartSell('nav')); await wait(300);
await page.click('#smSegScan'); await wait(1200);
scan = 'ohtani';
await page.click('#smShutter'); await wait(1500);
await page.click('.sm-dark-header .sm-dark-btn[aria-label=Close]'); await wait(300);
await page.evaluate(() => smGo('/scans')); await wait(800);
check('Recent scans lists the abandoned scan', (await page.locator('.sm-scan-row').count()) >= 1);
await tapCheck('recent scans');
page.once('dialog', d => d.accept('60'));
const invB2 = (await srv()).inventory.length;
await page.click('.sm-scan-row .sm-row-btn:has-text("Add to case")'); await wait(400); await flush();
s = await srv();
check('Add to case creates an available item with the photo', s.inventory.length === invB2 + 1 && s.inventory[s.inventory.length-1].status !== 'Sold' && s.inventory[s.inventory.length-1].price === 60
  && s.card_captures.filter(c => c.status === 'attached').length >= 3);

// ── 7. Reload on every route keeps the seller signed in on the same screen ──
for (const route of ['', '/inventory', '/sell', '/scans']) {
  await page.evaluate(r => smGo(r), route); await wait(300);
  await page.reload(); await wait(1800);
  const h = await hash();
  check(`reload ${route || '/'} → signed in, same screen`, (await page.evaluate(() => currentRole)) === 'seller' && h === '#/sm/show_a' + route && await page.locator('#showModeRoot').isVisible(), h);
}
await page.evaluate(() => smPickCard('c2'.replace('c2', inventory.find(c => c.Status !== 'Sold' && c.Seller === currentSeller)._dbId), 'inventory_row')); await wait(300);
await page.click('[data-chip=minus10]'); await wait(100);
await page.reload(); await wait(1800);
check('reload /confirm → same card and chip', (await hash()).endsWith('/confirm') && (await page.getAttribute('[data-chip=minus10]', 'aria-pressed')) === 'true');

console.log('errors:', JSON.stringify(errors.filter(e => !/favicon/.test(e))));
await browser.close();
