// Show Mode: the double-sale dialog and offline inventory (cards + shows saved
// on the device for a reload with no signal). Run like the others:
//   node double-sale-offline.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
// "No signal" without actually cutting the page off from the test server, so
// it can still reload: navigator.onLine reads a flag the test flips.
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return localStorage.getItem('__offline') !== '1'; } });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const setOffline = async on => {
  await page.evaluate(on => { localStorage.setItem('__offline', on ? '1' : '0'); if (!on) window.dispatchEvent(new Event('online')); }, on);
};
const sell = (id, payment) => page.evaluate(([id, payment]) => {
  _smDraft = { showId: 'show_a', mode: 'sell', itemKey: id, newItem: null, captureId: null, chip: 'asking', otherPrice: '', payment, buyerHandle: '' };
  return smMarkSold();
}, [id, payment]);
const mutateSrv = fn => page.evaluate(src => {
  const S = window.__srv;   // the live object the mock reads
  (new Function('S', src))(S);
  localStorage.setItem('__srv', JSON.stringify(S));
}, fn);

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html?show_mode=1');
await wait(400);
await page.evaluate(() => {
  const S = window.__srv;
  S.inventory.push(
    { id: 'c4', seller_id: 'u1', card_title: '2022 Topps Julio Rodriguez', player: 'Julio Rodriguez', year: 2022, card_set: 'Topps', price: 50, status: 'Available' },
    { id: 'c5', seller_id: 'u1', card_title: '2021 Bowman Bobby Witt', player: 'Bobby Witt', year: 2021, card_set: 'Bowman', price: 25, status: 'Available' },
  );
  S.show_inventory.push({ show_id: 'show_a', card_id: 'c4' }, { show_id: 'show_a', card_id: 'c5' });
  localStorage.setItem('__srv', JSON.stringify(S));
});
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2200);

// ── Offline inventory ──
let cache = await page.evaluate(() => smStore.get('cache', 'inv:tester'));
check('inventory saved on the device after loading', cache && cache.cards.length === 5, cache && String(cache.cards.length));
const showCache = await page.evaluate(() => smStore.get('cache', 'shows:tester'));
check('the seller\'s shows saved too', showCache && showCache.shows.length === 1 && showCache.shows[0].id === 'show_a');
check('cached cards keep their show membership', cache && cache.cards.find(c => c._dbId === 'c1')._shows.includes('show_a'));

await page.reload(); await wait(2200);           // online restore caches the handle for an offline one
await setOffline(true);
await page.reload(); await wait(2500);
check('offline reload: still signed in', await page.evaluate(() => currentSeller === 'tester'));
check('offline reload: cards shown from the device', await page.evaluate(() => getSellerInventory().length === 5));
check('offline reload: Show Mode opens on today\'s show', await page.evaluate(() => _smShowId === 'show_a'));
const homeText = await page.textContent('#smView');
check('offline reload: "No signal" notice on home', /No signal\. Showing your cards as of/.test(homeText));
check('offline reload: In case count from the cache', await page.evaluate(() => [...document.querySelectorAll('.sm-stat')].map(e => e.textContent).join('|').includes('4In case')));

await sell('c2', 'Cash'); await wait(500);
check('offline sale: card shows sold locally', await page.evaluate(() => getSellerInventory().find(c => c._dbId === 'c2').Status === 'Sold'));
await page.reload(); await wait(2500);
check('offline sale survives another offline reload', await page.evaluate(() => getSellerInventory().find(c => c._dbId === 'c2').Status === 'Sold'));
check('server not written while offline', (await srv()).inventory.find(c => c.id === 'c2').status === 'Available');

await setOffline(false); await wait(2500);
let S = await srv();
check('back online: queued sale reaches the server', S.inventory.find(c => c.id === 'c2').status === 'Sold' && S.sales.filter(s => s.inventory_id === 'c2').length === 1);
check('back online: live inventory replaces the cached copy', await page.evaluate(() => _smOfflineSince === null));
check('back online: notice gone', !(await page.textContent('#smView')).includes('No signal'));

// ── Double sale: earlier Show Mode sale on another phone → undo it, keep mine ──
await mutateSrv(`
  const c = S.inventory.find(x => x.id === 'c1');
  Object.assign(c, { status: 'Sold', sold_price: 100, payment_method: 'Venmo', sold_time: '2:00 PM' });
  S.sales.push({ id: 'sale_other', client_sale_id: 'other-1', seller_id: 'u1', inventory_id: 'c1', show_id: 'show_a', price: 100, payment_method: 'Venmo', status: 'completed', sold_at: new Date().toISOString(), source: 'show_mode' });
`);
await sell('c1', 'Cash'); await wait(1500);
check('dialog opens when the card was already sold', await page.isVisible('#smConflictOverlay'));
let dlg = await page.textContent('#smConflictOverlay');
check('dialog shows both sales', dlg.includes('$100') && dlg.includes('Venmo') && dlg.includes('$120') && dlg.includes('Cash'), dlg.replace(/\s+/g, ' ').slice(0, 200));
check('graded slab: no "second copy" option', !(await page.$('#smConflictOverlay [data-act="copy"]')));
check('recent earlier sale: "undo the earlier sale" offered', !!(await page.$('#smConflictOverlay [data-act="replace"]')));
const h = await page.$eval('#smConflictOverlay [data-act="keep"]', b => b.getBoundingClientRect().height);
check('dialog buttons ≥44px', h >= 44, String(h));
await page.click('#smConflictOverlay [data-act="replace"]'); await wait(1500);
S = await srv();
const c1 = S.inventory.find(c => c.id === 'c1');
check('replace: earlier sale voided', S.sales.find(s => s.client_sale_id === 'other-1').status === 'voided');
check('replace: my sale recorded', c1.status === 'Sold' && c1.sold_price === 120 && c1.payment_method === 'Cash'
  && S.sales.filter(s => s.inventory_id === 'c1' && s.status === 'completed').length === 1, JSON.stringify(c1));
check('replace: dialog closed', !(await page.$('#smConflictOverlay')));

// ── Earlier sale from the classic view (no Show Mode sale) → second copy ──
await mutateSrv(`Object.assign(S.inventory.find(x => x.id === 'c4'), { status: 'Sold', sold_price: 45, payment_method: 'Cash', sold_date: '2026-10-27', sold_time: '1:00 PM' });`);
await sell('c4', 'Card'); await wait(1500);
dlg = await page.textContent('#smConflictOverlay');
check('classic earlier sale shown from the inventory row', dlg.includes('$45') && dlg.includes('1:00 PM'));
check('classic earlier sale: no undo option', !(await page.$('#smConflictOverlay [data-act="replace"]')));
await page.click('#smConflictOverlay [data-act="copy"]'); await wait(1500);
S = await srv();
const julios = S.inventory.filter(c => c.player === 'Julio Rodriguez');
const copy = julios.find(c => c.id !== 'c4');
check('second copy: new card created and sold', julios.length === 2 && copy && copy.status === 'Sold' && copy.sold_price === 50 && copy.payment_method === 'Card', JSON.stringify(julios));
check('second copy: earlier sale untouched', S.inventory.find(c => c.id === 'c4').sold_price === 45);
check('second copy: local inventory has both', await page.evaluate(() => getSellerInventory().filter(c => c.Player === 'Julio Rodriguez').length === 2));

// ── Decide later → asked again after a reload → keep the earlier sale ──
await mutateSrv(`Object.assign(S.inventory.find(x => x.id === 'c5'), { status: 'Sold', sold_price: 20, payment_method: 'Venmo' });`);
await sell('c5', 'Cash'); await wait(1500);
await page.click('#smConflictOverlay [data-act="later"]'); await wait(300);
check('decide later: dialog closes', !(await page.$('#smConflictOverlay')));
await page.reload(); await wait(2800);
check('decide later: asked again after a reload', await page.isVisible('#smConflictOverlay') && (await page.textContent('#smConflictOverlay')).includes('Bobby Witt'));
await page.click('#smConflictOverlay [data-act="keep"]'); await wait(800);
S = await srv();
check('keep: earlier sale stands, nothing new recorded', S.inventory.find(c => c.id === 'c5').sold_price === 20 && !S.sales.some(s => s.inventory_id === 'c5'));
check('keep: card shows the earlier sale locally', await page.evaluate(() => { const c = getSellerInventory().find(x => x._dbId === 'c5'); return c.Status === 'Sold' && Number(c.SoldPrice) === 20; }));
await page.reload(); await wait(2500);
check('keep: not asked again', !(await page.$('#smConflictOverlay')));

// ── Sign-out clears the device copy ──
await page.evaluate(() => signOut()); await wait(800);
cache = await page.evaluate(() => smStore.get('cache', 'inv:tester'));
check('sign-out removes the cached inventory', !cache);
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
