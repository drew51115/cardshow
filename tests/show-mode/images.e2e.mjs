// Show Mode Phase 4: card images (own photo from another device, stock image,
// blank), catalog ids saved on new cards, and the share card's photo pre-fill
// and handle opt-in. Run like the others:  node images.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);

const CAT_OK = '11111111-1111-4111-8111-111111111111';
const CAT_NONE = '22222222-2222-4222-8222-222222222222';
const CAT_NEW = '33333333-3333-4333-8333-333333333333';
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const imageHits = [];
// Registered first: Playwright tries the most recently added route first.
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
await ctx.route('**/__signed/**', r => r.fulfill({ contentType: 'image/png', body: PNG }));
await ctx.route('**/.netlify/functions/card-image**', r => {
  const id = new URL(r.request().url()).searchParams.get('id');
  imageHits.push(id);
  return id === CAT_OK ? r.fulfill({ contentType: 'image/png', body: PNG }) : r.fulfill({ status: 404, body: 'No image' });
});

await page.goto(BASE + '/app.html?show_mode=1');
await wait(400);
await page.evaluate(([CAT_OK, CAT_NONE]) => {
  const S = window.__srv;
  S.sellers[0].instagram = '@tester_cards';
  S.inventory = [
    { id: 'p1', seller_id: 'u1', card_title: 'Photo card', player: 'Photo Card', year: 2024, card_set: 'Set', price: 10, status: 'Available', primary_capture_id: 'cap1', image_source: 'seller' },
    { id: 'p2', seller_id: 'u1', card_title: 'Stock card', player: 'Stock Card', year: 2024, card_set: 'Set', price: 20, status: 'Available', catalog_card_id: CAT_OK, image_source: 'stock' },
    { id: 'p3', seller_id: 'u1', card_title: 'No image card', player: 'Missing Image', year: 2024, card_set: 'Set', price: 30, status: 'Available', catalog_card_id: CAT_NONE },
    { id: 'p4', seller_id: 'u1', card_title: 'Plain card', player: 'Plain Card', year: 2024, card_set: 'Set', price: 40, status: 'Available' },
    { id: 'p5', seller_id: 'u1', card_title: 'Uploading card', player: 'Uploading Card', year: 2024, card_set: 'Set', price: 50, status: 'Available', primary_capture_id: 'cap2' },
  ];
  S.show_inventory = S.inventory.map(c => ({ show_id: 'show_a', card_id: c.id }));
  S.card_captures = [
    { id: 'cap1', seller_id: 'u1', entry_point: 'sell_card', crop_key: 'u1/cap1/crop.jpg', uploaded_at: new Date().toISOString(), inventory_id: 'p1', status: 'attached' },
    { id: 'cap2', seller_id: 'u1', entry_point: 'sell_card', crop_key: 'u1/cap2/crop.jpg', uploaded_at: null, inventory_id: 'p5', status: 'attached' },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
}, [CAT_OK, CAT_NONE]);
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(1800);
await page.evaluate(() => smGo('/inventory')); await wait(1200);

const thumbs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#showModeRoot .sm-row')].map(row => {
  const name = row.querySelector('.sm-row-title')?.textContent || '';
  const t = row.querySelector('.sm-thumb');
  return [name, t ? (t.tagName === 'IMG' ? (t.classList.contains('sm-thumb--stock') ? 'stock:' : 'img:') + t.getAttribute('src') : 'blank') : 'none'];
})));
check('photo taken on another device shows (signed URL)', /^img:.*\/__signed\/u1\/cap1\/crop\.jpg$/.test(thumbs['Photo Card'] || ''), thumbs['Photo Card']);
check('card with a catalog id shows the stock image', (thumbs['Stock Card'] || '').startsWith('stock:/.netlify/functions/card-image?id=' + CAT_OK), thumbs['Stock Card']);
check('stock image CardSight lacks falls back to a blank tile', thumbs['Missing Image'] === 'blank', thumbs['Missing Image']);
check('card with no photo or catalog id is a blank tile', thumbs['Plain Card'] === 'blank', thumbs['Plain Card']);
check('photo not uploaded yet is a blank tile', thumbs['Uploading Card'] === 'blank', thumbs['Uploading Card']);
const reHits = imageHits.length;
await page.evaluate(() => smRefresh()); await wait(600);
check('a missing stock image is not requested again', imageHits.filter(i => i === CAT_NONE).length === 1, JSON.stringify(imageHits));
const capLookups = await page.evaluate(() => window.__mockLog.filter(l => l.table === 'card_captures' && l.op === 'select').length);
await page.evaluate(() => smRefresh()); await wait(400);
check('signed URLs are not re-fetched on every render',
  (await page.evaluate(() => window.__mockLog.filter(l => l.table === 'card_captures' && l.op === 'select').length)) === capLookups);
const coverage = await page.evaluate(() => (window.__srv.show_events.find(e => e.event_type === 'sm_images_shown') || {}).event_data);
check('image coverage logged once (stock = has a catalog id)', coverage && coverage.seller === 1 && coverage.stock === 2 && coverage.none === 2, JSON.stringify(coverage));

// ── Catalog id saved with a new card ──
await page.evaluate(async (CAT_NEW) => { await _smAddNewCard({ player: 'New Catalog Card', year: 2025, cardSet: 'Topps' }, '15', null, CAT_NEW); await smDrain(); }, CAT_NEW);
await wait(500);
const added = await page.evaluate(() => window.__srv.inventory.find(r => r.player === 'New Catalog Card'));
check('new card saved with its catalog id', added && added.catalog_card_id === CAT_NEW, JSON.stringify(added && added.catalog_card_id));
await page.evaluate(() => _smAddNewCard({ player: 'Bad Id Card' }, '5', null, 'cat-1').then(() => smDrain())); await wait(500);
check('non-CardSight id is not saved', !(await page.evaluate(() => window.__srv.inventory.find(r => r.player === 'Bad Id Card') || {})).catalog_card_id);
await page.evaluate((CAT_NEW) => _saveCatalogCardId(inventory.find(c => c._dbId === 'p4'), CAT_NEW), CAT_NEW); await wait(300);
check('comp-check catalog id saved on a card that had none', (await page.evaluate(() => window.__srv.inventory.find(r => r.id === 'p4').catalog_card_id)) === CAT_NEW);

// ── Share card: photo pre-fill + handle opt-in ──
await page.evaluate(() => openShareCardModal(inventory.find(c => c._dbId === 'p2'), 'show_a', 'show_mode')); await wait(1200);
check('share card fills in the stock image (share body shown)', await page.isVisible('#dropShareBody'));
check('says it is the catalog image', (await page.textContent('#dropPhotoSource')).includes('Catalog image'));
check('handle opt-in shown, off by default, with the Instagram handle',
  await page.isVisible('#dropHandleRow') && !(await page.isChecked('#dropShowHandle')) && (await page.textContent('#dropHandleLabel')) === '@tester_cards');
check('caption has no seller handle while off', !(await page.textContent('#dropCaptionFooter')).includes('Sold by'));
await page.evaluate(() => { window.__texts = []; const f = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (t, ...r) { window.__texts.push(String(t)); return f.call(this, t, ...r); }; });
await page.check('#dropShowHandle'); await wait(600);
check('handle drawn on the image, after the venue', await page.evaluate(() => window.__texts.some(t => /@tester_cards$/.test(t))),
  JSON.stringify(await page.evaluate(() => window.__texts.filter(t => t.includes('@')))));
check('turning it on adds the handle to the caption', (await page.textContent('#dropCaptionFooter')).startsWith('Sold by @tester_cards'));
check('choice saved on the seller', (await page.evaluate(() => window.__srv.sellers[0].share_handle)) === true);
check('canvas still exportable (not tainted)', await page.evaluate(() => { try { return document.getElementById('dropShareCanvas').toDataURL().length > 100; } catch (e) { return false; } }));
await page.evaluate(() => closeShareCardModal());
await page.evaluate(() => openShareCardModal(inventory.find(c => c._dbId === 'p1'), 'show_a', 'show_mode')); await wait(1200);
check('own photo from another device fills the share card', (await page.textContent('#dropPhotoSource')).includes('Your photo'));
check('handle choice remembered', await page.isChecked('#dropShowHandle'));
await page.evaluate(() => closeShareCardModal());
await page.evaluate(() => openShareCardModal(inventory.find(c => c._dbId === 'p3'), 'show_a', 'show_mode')); await wait(1000);
check('no photo available → photo step stays', await page.isVisible('#dropPhotoSection') && !(await page.isVisible('#dropShareBody')));
await page.evaluate(() => closeShareCardModal());
const ev = await page.evaluate(() => window.__srv.show_events.map(e => e.event_type));
check('share events logged', ev.includes('share_opened') && ev.includes('share_handle'), JSON.stringify(ev.filter(e => e.startsWith('share'))));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
