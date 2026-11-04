// Seller self-join: Join a show, the Show Mode gate, Leave show, organizer tag,
// and the pre-migration fallback. Run like show-mode.e2e.mjs:
//   node join-show.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const legacy = fs.readFileSync(new URL('./mock-supabase-legacy.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };

async function setup(mockSrc) {
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mockSrc }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
  await page.goto(BASE + '/app.html?show_mode=1');
  await page.waitForTimeout(400);
  // The seller starts in no show; three more shows exist.
  await page.evaluate(() => {
    const S = window.__srv, today = new Date().toLocaleDateString('en-CA');
    const old = new Date(Date.now() - 10 * 864e5).toLocaleDateString('en-CA');
    S.show_sellers = [];
    S.shows.push(
      { id:'show_b', name:'Card Expo', date:'Today', access_code:'EXPO', location:'Fresno, CA', status:'active', start_date: today, end_date: today },
      { id:'show_c', name:'Invite Only Show', date:'Today', location:'Reno, NV', status:'active', start_date: today, end_date: today, seller_self_join: false },
      { id:'show_d', name:'Last Month Show', date:'', location:'Davis, CA', status:'past', start_date: old, end_date: old });
    localStorage.setItem('__srv', JSON.stringify(S));
  });
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.evaluate(() => submitAuth());
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

{
  const { ctx, page, errors } = await setup(mock);
  const srv = () => page.evaluate(() => window.__srv);
  check('no show joined → Show Mode does not open on its own', !(await page.isVisible('#showModeRoot.open')));
  check('Show Mode button still shown', await page.isVisible('#navShowModeBtn'));

  await page.click('#navShowModeBtn'); await page.waitForTimeout(400);
  check('Show Mode button opens Join a show first', await page.isVisible('#joinShowOverlay.open'));
  check('explains why', (await page.textContent('#joinShowReason')).includes('to open Show Mode'));
  const names = await page.$$eval('.join-show-name', els => els.map(e => e.textContent.trim()));
  check('lists open shows only (not organizer-only or past ones)',
    names.some(n => n.startsWith('Monster Show')) && names.some(n => n.startsWith('Card Expo')) && !names.some(n => /Invite Only|Last Month/.test(n)), JSON.stringify(names));
  check('today tag', (await page.textContent('#joinShowList')).includes('Today'));
  await page.fill('#joinShowSearch', 'fresno'); await page.waitForTimeout(100);
  check('search by city', (await page.$$('.join-show-row')).length === 1 && (await page.textContent('#joinShowList')).includes('Card Expo'));
  await page.fill('#joinShowSearch', ''); await page.waitForTimeout(100);
  const small = await page.$$eval('#joinShowOverlay button', bs => bs.filter(b => b.offsetParent && b.classList.contains('join-show-btn')).map(b => b.getBoundingClientRect().height).filter(h => h < 44));
  check('Join buttons ≥44px tall', small.length === 0, JSON.stringify(small));

  await page.click('.join-show-row:has-text("Monster Show") .join-show-btn'); await page.waitForTimeout(800);
  let s = await srv();
  check('server: self_joined row for Monster Show', s.show_sellers.some(r => r.show_id === 'show_a' && r.seller_id === 'u1' && r.self_joined));
  check('Show Mode opens for that show after joining', await page.isVisible('#showModeRoot.open') && (await page.evaluate(() => location.hash)).startsWith('#/sm/show_a'));

  await page.evaluate(() => smOpenClassic('inventory')); await page.waitForTimeout(300);
  await page.evaluate(() => _helpShowSidebar('sellerShowsPanel')); await page.waitForTimeout(300);
  check('My Shows has Leave show for a show you joined', await page.isVisible('#sellerShowsList button:has-text("Leave show")'));
  await page.evaluate(() => sellerPublishToShow('show_a')); await page.waitForTimeout(500);
  check('Add My Cards still works', (await srv()).show_inventory.filter(r => r.show_id === 'show_a').length >= 2);
  await page.click('#sellerShowsList button:has-text("Leave show")'); await page.waitForTimeout(600);
  s = await srv();
  check('Leave show removes the row and the cards', !s.show_sellers.some(r => r.show_id === 'show_a') && !s.show_inventory.some(r => r.show_id === 'show_a'));
  check('Leave show updates My Shows', (await page.textContent('#sellerShowsList')).includes('haven\'t joined a show'));

  // A Show Mode link for a show they're not in asks them to join it.
  await page.evaluate(() => { location.hash = '#/sm/show_b'; location.reload(); });
  await page.waitForTimeout(1800);
  check('Show Mode link to an unjoined show → Join a show with it at the top',
    await page.isVisible('#joinShowOverlay.open') && (await page.textContent('.join-show-row.focus')).includes('Card Expo') && !(await page.isVisible('#showModeRoot.open')));
  await page.click('.join-show-row.focus .join-show-btn'); await page.waitForTimeout(800);
  check('joined → Show Mode opens for it', (await page.evaluate(() => location.hash)).startsWith('#/sm/show_b'));
  check('joining the same show again is harmless', (await page.evaluate(() => db.rpc('join_show_as_seller', { p_show_id: 'show_b' }))).data.already === true);
  check('server refuses an organizer-only show', (await page.evaluate(() => db.rpc('join_show_as_seller', { p_show_id: 'show_c' }))).data.error === 'closed');

  // Organizer view: tag on the seller chip, and the switch.
  await page.evaluate(() => { closeShowMode(); loadShowsFromDB().then(() => openCreateShowModal('show_b')); }); await page.waitForTimeout(900);
  check('organizer sees "joined themselves" on the seller', (await page.textContent('#smSellerChipRow')).includes('joined themselves'));
  check('Let sellers add themselves is on', await page.isChecked('#smSelfJoin'));
  await page.uncheck('#smSelfJoin');
  await page.evaluate(() => saveShow()); await page.waitForTimeout(800);
  s = await srv();
  check('switch saved to shows.seller_self_join', s.shows.find(x => x.id === 'show_b').seller_self_join === false);
  check('join screen is a top-level element (not inside a hidden view)', await page.evaluate(() => document.getElementById('joinShowOverlay').parentElement === document.body));
  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

{ // Before the migration: the join falls back to a plain insert.
  const { ctx, page, errors } = await setup(legacy);
  await page.evaluate(() => openJoinShow()); await page.waitForTimeout(300);
  await page.click('.join-show-row:has-text("Card Expo") .join-show-btn'); await page.waitForTimeout(800);
  const s = await page.evaluate(() => window.__srv);
  check('fallback: show_sellers row inserted without the RPC', s.show_sellers.some(r => r.show_id === 'show_b' && r.seller_id === 'u1'));
  check('fallback: show appears under My Shows', (await page.textContent('#sellerShowsList')).includes('Card Expo'));
  check('fallback: no page errors', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
