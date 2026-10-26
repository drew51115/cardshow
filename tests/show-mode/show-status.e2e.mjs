// Show status follows the dates (Upcoming / Active (Live) / Past). Run like the others:
//   node show-status.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const iso = d => d.toLocaleDateString('en-CA');
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await page.goto(BASE + '/app.html');
await page.waitForTimeout(400);
await page.evaluate(d => {
  const S = window.__srv;
  S.admins = [{ id: 'u1' }];
  S.platform_admins = [{ id: 'u1' }];
  // Stored statuses are all wrong on purpose.
  S.shows = [
    { id: 'show_past',   name: 'Past Show',   start_date: d.m10, end_date: d.m8, status: 'active',   access_code: 'PST', created_by: 'u1' },
    { id: 'show_live',   name: 'Live Show',   start_date: d.m1,  end_date: d.p1, status: 'upcoming', access_code: 'LIV', created_by: 'u1' },
    { id: 'show_future', name: 'Future Show', start_date: d.p5,  end_date: d.p6, status: 'past',     access_code: 'FUT', created_by: 'u1' },
    { id: 'show_text',   name: 'Text Date',   date: 'Jan 5-6, 2020',              status: 'active',   access_code: 'TXT', created_by: 'u1' },
    { id: 'show_none',   name: 'No Date',                                          status: 'active',   access_code: 'NON', created_by: 'u1' },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
}, { m10: day(-10), m8: day(-8), m1: day(-1), p1: day(1), p5: day(5), p6: day(6) });
await page.evaluate(() => {
  authRoleSelected = 'admin';
  document.getElementById('authAdminEmail').value = 't@x.com';
  document.getElementById('authAdminPass').value = 'password1';
});
await page.evaluate(() => submitAuth());
await page.waitForTimeout(1500);

const st = await page.evaluate(() => Object.fromEntries(Object.values(shows).map(s => [s.id, s.status])));
check('past dates → Past', st.show_past === 'past', st.show_past);
check('running today → Active', st.show_live === 'active', st.show_live);
check('future dates → Upcoming', st.show_future === 'upcoming', st.show_future);
check('freeform date text only → Past', st.show_text === 'past', st.show_text);
check('no date → stored status kept', st.show_none === 'active', st.show_none);
const grid = await page.textContent('#adminShowsGrid');
check('dashboard shows the derived labels', await page.evaluate(() => ['show_past','show_live','show_future'].map(id => document.querySelector('#asc-' + id + ' .asc-status')?.textContent).join('/')) === 'Past/Active (Live)/Upcoming');

const order = await page.evaluate(() => [...document.querySelectorAll('#adminShowsGrid .admin-show-card')].map(e => e.dataset.showid).join(','));
check('dashboard order: active, upcoming, past (newest first)', order === 'show_live,show_none,show_future,show_past,show_text', order);

await page.click('#adminTabDirectory'); await page.waitForTimeout(600);
await page.click('.dir-filter:has-text("All")'); await page.waitForTimeout(200);
const dirOrder = await page.evaluate(() => [...document.querySelectorAll('#dirList [data-show-id]')].map(e => e.dataset.showId).join(','));
check('Show Directory order matches the dashboard', dirOrder === 'show_live,show_none,show_future,show_past,show_text', dirOrder);
await page.evaluate(() => switchAdminTab('shows')); await page.waitForTimeout(300);

// Modal: no manual status; preview follows the dates.
await page.evaluate(() => openCreateShowModal('show_future'));
await page.waitForTimeout(300);
check('status dropdown removed', !(await page.$('#smStatus')));
check('modal shows Upcoming for future dates', (await page.textContent('#smStatusAuto')).includes('Upcoming'));
await page.fill('#smStartDate', day(0)); await page.fill('#smEndDate', day(0));
await page.dispatchEvent('#smStartDate', 'input');
check('changing dates to today shows Active (Live)', (await page.textContent('#smStatusAuto')).includes('Active (Live)'));
await page.evaluate(() => saveShow());
await page.waitForTimeout(800);
const saved = await page.evaluate(() => window.__srv.shows.find(s => s.id === 'show_future').status);
check('saving writes the derived status to the DB', saved === 'active', saved);

await page.evaluate(() => openCreateShowModal());
await page.waitForTimeout(200);
check('new show modal: status says it comes from the dates', (await page.textContent('#smStatusAuto')).includes('Set from the dates'));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
