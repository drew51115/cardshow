// My Shows (seller sidebar) lists the most recent show first; shows with no
// readable date go last. Run like show-mode.e2e.mjs:
//   node seller-shows-order.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };

const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await page.goto(BASE + '/app.html');
await page.waitForTimeout(400);
await page.evaluate(() => {
  const S = window.__srv;
  const sellerId = S.sellers[0].id;
  // Inserted oldest-created first, in an order that doesn't match their dates.
  S.shows = [
    { id:'s_aug', name:'Aug Expo', date:'Aug 6-8, 2026', location:'Lakewood, CA', status:'past', start_date:'2026-08-06', end_date:'2026-08-08' },
    { id:'s_legends', name:'Legends Show', date:'August 1st, 2026', location:'Las Vegas', status:'past' },
    { id:'s_nov', name:'Nov Expo', date:'Nov 6-8, 2026', location:'Lakewood, CA', status:'upcoming', start_date:'2026-11-06', end_date:'2026-11-08' },
    { id:'s_sep', name:'Sep Expo', date:'Sep 19-20, 2026', location:'Lakewood, CA', status:'past', start_date:'2026-09-19', end_date:'2026-09-20' },
    { id:'s_nodate', name:'No Date Show', date:'TBD', location:'Reno, NV', status:'upcoming' },
  ];
  S.show_sellers = S.shows.map(s => ({ show_id: s.id, seller_id: sellerId, table_number: null }));
  localStorage.setItem('__srv', JSON.stringify(S));
});
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await page.waitForTimeout(1500);

const names = await page.$$eval('#sellerShowsList .show-card-name', els => els.map(e => e.textContent.trim()));
check('most recent first, undated last',
  JSON.stringify(names) === JSON.stringify(['Nov Expo', 'Sep Expo', 'Aug Expo', 'Legends Show', 'No Date Show']),
  JSON.stringify(names));
check('no page errors', errors.length === 0, JSON.stringify(errors));

await browser.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
