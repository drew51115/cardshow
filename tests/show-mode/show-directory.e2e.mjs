// Show directory (platform owner) + seller show requests. Run like show-mode.e2e.mjs:
//   node show-directory.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const legacy = fs.readFileSync(new URL('./mock-supabase-legacy.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const today = new Date().toLocaleDateString('en-CA');

async function setup(mockSrc, seed, asAdmin) {
  const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('Not a card show') : d.accept());
  await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mockSrc }));
  await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
  await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
  await page.goto(BASE + '/app.html?show_mode=1');
  await page.waitForTimeout(400);
  await page.evaluate(seed, today);
  if (asAdmin) await page.evaluate(() => {
    authRoleSelected = 'admin';
    document.getElementById('authAdminEmail').value = 't@x.com';
    document.getElementById('authAdminPass').value = 'password1';
  });
  else { await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1'); }
  await page.evaluate(() => submitAuth());
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
const srv = page => page.evaluate(() => window.__srv);

// ── Platform owner ──
{
  const { ctx, page, errors } = await setup(mock, today => {
    const S = window.__srv;
    S.sellers = [{ id: 'u2', handle: 'carol' }];
    S.admins = [{ id: 'u1' }];
    S.platform_admins = [{ id: 'u1' }];
    S.shows = [
      { id: 'show_a', name: 'Monster Show', date: 'Today', start_date: today, end_date: today, venue: 'Cal Expo', city: 'Sacramento', state: 'CA', location: 'Cal Expo, Sacramento, CA', status: 'active', access_code: 'MON', listed: false, created_by: 'u1' },
      { id: 'show_b', name: 'Monster Collectibles Show', start_date: today, end_date: today, venue: 'Cal Expo', city: 'Sacramento', state: 'CA', status: 'active', access_code: 'MCS', listed: false, created_by: 'other' },
      { id: 'show_c', name: 'Half Done', status: 'upcoming', access_code: 'HLF', listed: false, created_by: 'other', city: 'Reno' },
    ];
    S.show_sellers = [{ show_id: 'show_b', seller_id: 'u2', table_number: '7', self_joined: true }];
    S.show_inventory = [{ show_id: 'show_b', card_id: 'c1' }];
    S.show_requests = [
      { id: 'req_a', seller_id: 'u2', name: 'Fresno Card Expo', start_date: '2027-01-10', end_date: '2027-01-11', city: 'Fresno', state: 'CA', status: 'pending', created_at: new Date().toISOString(), website: 'https://example.com' },
      { id: 'req_b', seller_id: 'u2', name: 'Monster Show', start_date: today, city: 'Sacramento', state: 'CA', status: 'pending', created_at: new Date().toISOString() },
      { id: 'req_c', seller_id: 'u2', name: 'My garage sale', start_date: '2027-02-01', status: 'pending', created_at: new Date().toISOString() },
    ];
    localStorage.setItem('__srv', JSON.stringify(S));
  }, true);

  check('Show Directory tab shown to the platform owner', await page.isVisible('#adminTabDirectory'));
  check('tab shows pending request count', (await page.textContent('#dirTabBadge')).trim() === '3');
  await page.click('#adminTabDirectory'); await page.waitForTimeout(600);
  check('opens on Requests when any are waiting', (await page.$$('.dir-req')).length === 3);
  check('request shows who asked', (await page.textContent('.dir-req[data-request-id="req_a"]')).includes('@carol'));

  await page.click('.dir-filter:has-text("Needs info")'); await page.waitForTimeout(150);
  check('Needs info lists the incomplete show and what is missing',
    (await page.textContent('#dirList')).includes('Half Done') && (await page.textContent('#dirList')).includes('Needs: start date, venue, state'));
  await page.click('.dir-filter:has-text("Ready to list")'); await page.waitForTimeout(150);
  check('duplicate warning on same city + dates', (await page.textContent('[data-show-id="show_b"]')).includes('Possible duplicate of Monster Show'));

  await page.click('[data-show-id="show_a"] button:has-text("List")'); await page.waitForTimeout(600);
  let s = await srv(page);
  check('List: show_a listed with a slug', s.shows.find(x => x.id === 'show_a').listed === true && /^monster-show-\d{4}-\d{2}$/.test(s.shows.find(x => x.id === 'show_a').slug));

  // Merge the duplicate into the listed one (pre-selected).
  await page.click('[data-show-id="show_b"] button:has-text("Merge")'); await page.waitForTimeout(200);
  check('merge pre-selects the likely duplicate', (await page.inputValue('#dirMergeInto')) === 'show_a');
  await page.click('#dirMergeOverlay button:has-text("Merge")'); await page.waitForTimeout(600);
  s = await srv(page);
  check('merge moved the seller with their table and the card',
    s.show_sellers.some(r => r.show_id === 'show_a' && r.seller_id === 'u2' && r.table_number === '7') && s.show_inventory.some(r => r.show_id === 'show_a' && r.card_id === 'c1'));
  check('duplicate unlisted and marked merged', s.shows.find(x => x.id === 'show_b').merged_into === 'show_a');

  // Fill in the incomplete show and list it.
  await page.click('.dir-filter:has-text("Needs info")'); await page.waitForTimeout(150);
  await page.click('[data-show-id="show_c"] button:has-text("Edit")'); await page.waitForTimeout(200);
  await page.fill('#dirStart', '2027-03-05'); await page.fill('#dirVenue', 'Reno Events Center');
  await page.fill('#dirState', 'nv'); await page.dispatchEvent('#dirState', 'input');
  check('state is uppercased and fills the time zone', (await page.inputValue('#dirState')) === 'NV' && (await page.inputValue('#dirTimezone')) === 'America/Los_Angeles');
  await page.check('#dirListAfter');
  await page.click('#dirSaveBtn'); await page.waitForTimeout(700);
  s = await srv(page);
  const c = s.shows.find(x => x.id === 'show_c');
  check('saved fields + generated display text, then listed',
    c.listed === true && c.location === 'Reno Events Center, Reno, NV' && c.date === 'Mar 5, 2027' && c.timezone === 'America/Los_Angeles', JSON.stringify(c));

  // Requests: link, create & list, decline.
  await page.click('.dir-filter:has-text("Requests")'); await page.waitForTimeout(150);
  await page.click('.dir-req[data-request-id="req_b"] button:has-text("Link to Monster Show")'); await page.waitForTimeout(600);
  s = await srv(page);
  check('request linked to the matching listed show', s.show_requests.find(r => r.id === 'req_b').status === 'listed' && s.show_requests.find(r => r.id === 'req_b').show_id === 'show_a');

  await page.click('.dir-req[data-request-id="req_a"] button:has-text("Create")'); await page.waitForTimeout(200);
  check('Create & list pre-fills from the request', (await page.inputValue('#dirName')) === 'Fresno Card Expo' && (await page.inputValue('#dirCity')) === 'Fresno' && (await page.inputValue('#dirTimezone')) === 'America/Los_Angeles');
  await page.click('#dirSaveBtn'); await page.waitForTimeout(300);
  check('listing still needs a venue', await page.isVisible('#dirEditOverlay.open'));
  await page.fill('#dirVenue', 'Fresno Fairgrounds');
  await page.click('#dirSaveBtn'); await page.waitForTimeout(800);
  s = await srv(page);
  const fresno = s.shows.find(x => x.name === 'Fresno Card Expo');
  check('new show created, listed, request closed, seller added',
    fresno && fresno.listed && fresno.created_by === 'u1' && /^[A-Z0-9]{6}$/.test(fresno.access_code || '')
    && s.show_requests.find(r => r.id === 'req_a').show_id === fresno.id
    && s.show_sellers.some(r => r.show_id === fresno.id && r.seller_id === 'u2'));

  await page.click('.dir-req[data-request-id="req_c"] button:has-text("Decline")'); await page.waitForTimeout(600);
  s = await srv(page);
  check('decline with a note', s.show_requests.find(r => r.id === 'req_c').status === 'declined' && s.show_requests.find(r => r.id === 'req_c').review_note === 'Not a card show');
  check('no requests left', (await page.textContent('#dirList')).includes('No requests waiting') && !(await page.isVisible('#dirTabBadge')));

  await page.click('#adminTabShows'); await page.waitForTimeout(400);
  check('organizer card says Listed for sellers', (await page.textContent('#asc-show_a')).includes('Listed for sellers'));
  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

{ // An organizer who isn't the platform owner sees no directory, and the "not listed" note.
  const { ctx, page } = await setup(mock, today => {
    const S = window.__srv;
    S.sellers = []; S.admins = [{ id: 'u1' }]; S.platform_admins = [];
    S.shows = [{ id: 'show_a', name: 'My Show', start_date: today, end_date: today, status: 'upcoming', access_code: 'MYS', listed: false, created_by: 'u1' }];
    localStorage.setItem('__srv', JSON.stringify(S));
  }, true);
  check('regular organizer: no Show Directory tab', !(await page.isVisible('#adminTabDirectory')));
  check('regular organizer: card says not listed yet', (await page.textContent('#asc-show_a')).includes('Not listed yet'));
  await ctx.close();
}

// ── Seller ──
const sellerSeed = today => {
  const S = window.__srv;
  S.show_sellers = [];
  S.shows = [
    { id: 'show_a', name: 'Monster Show', date: 'Today', start_date: today, end_date: today, location: 'Cal Expo, Sacramento, CA', status: 'active', access_code: 'MON', listed: true },
    { id: 'show_b', name: 'Unreviewed Show', date: 'Today', start_date: today, end_date: today, status: 'active', access_code: 'UNR', listed: false },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
};
{
  const { ctx, page, errors } = await setup(mock, sellerSeed, false);
  await page.evaluate(() => openJoinShow()); await page.waitForTimeout(400);
  const names = await page.$$eval('.join-show-name', els => els.map(e => e.textContent.trim()));
  check('seller sees listed shows only', names.length === 1 && names[0].startsWith('Monster Show'), JSON.stringify(names));
  const h = await page.$eval('.join-show-request-btn', b => b.getBoundingClientRect().height);
  check('Request it button ≥44px', h >= 44, String(h));

  await page.fill('#joinShowSearch', 'Fresno Expo'); await page.waitForTimeout(100);
  await page.click('.join-show-request-btn'); await page.waitForTimeout(200);
  check('request form opens, name taken from the search', await page.isVisible('#joinShowRequestView') && (await page.inputValue('#reqName')) === 'Fresno Expo');
  await page.click('#reqSubmitBtn'); await page.waitForTimeout(200);
  check('start date required', (await srv(page)).show_requests === undefined || (await srv(page)).show_requests.length === 0);
  await page.fill('#reqStart', '2027-01-10'); await page.fill('#reqCity', 'Fresno'); await page.fill('#reqState', 'ca');
  await page.click('#reqSubmitBtn'); await page.waitForTimeout(600);
  let s = await srv(page);
  check('request saved', s.show_requests.length === 1 && s.show_requests[0].name === 'Fresno Expo' && s.show_requests[0].state === 'CA');
  check('back on the list with "Your requests"', await page.isVisible('#joinShowListView') && (await page.textContent('#joinShowMyRequests')).includes('Waiting for review'));
  await page.click('.join-show-request-btn'); await page.fill('#reqName', 'fresno expo'); await page.fill('#reqStart', '2027-01-10');
  await page.click('#reqSubmitBtn'); await page.waitForTimeout(600);
  check('same request twice is not duplicated', (await srv(page)).show_requests.length === 1 && (await page.textContent('#toast')).includes('already asked'));

  await page.evaluate(() => { closeJoinShow(); openShowMode('show_b'); }); await page.waitForTimeout(500);
  check('Show Mode for an unlisted show: shown at top, not joinable',
    (await page.textContent('.join-show-row.focus')).includes('Not open to sellers yet') && !(await page.$('.join-show-row.focus .join-show-btn')));
  check('server refuses an unlisted show', (await page.evaluate(() => db.rpc('join_show_as_seller', { p_show_id: 'show_b' }))).data.error === 'not_listed');
  check('seller: no page errors', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}
{ // Before the migration: request says it isn't set up.
  const { ctx, page } = await setup(legacy, sellerSeed, false);
  await page.evaluate(() => { openJoinShow(); openShowRequestForm(); });
  await page.fill('#reqName', 'Any Show'); await page.fill('#reqStart', '2027-01-10');
  await page.click('#reqSubmitBtn'); await page.waitForTimeout(500);
  check('fallback: explains requests are not set up', (await page.textContent('#toast')).includes("aren't set up"));
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
