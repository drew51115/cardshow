// Sign out → the sign-in button must be usable again (it used to stay on "Loading…").
//   node auth-signout.e2e.mjs "iPhone 13"
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
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
const btnState = () => page.$eval('#authSubmitBtn', b => ({ disabled: b.disabled, text: b.textContent.trim() }));

await page.goto(BASE + '/app.html'); await wait(500);
for (const round of [1, 2]) {
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.click('#authSubmitBtn'); await wait(2000);
  check(`round ${round}: signed in`, await page.evaluate(() => currentSeller === 'tester'));
  await page.evaluate(() => signOut()); await wait(800);
  check(`round ${round}: sign-in screen shown`, await page.isVisible('#authOverlay'));
  const s = await btnState();
  check(`round ${round}: Enter button ready after sign-out`, !s.disabled && s.text === 'Enter →', JSON.stringify(s));
}
// Signing out from sign-up mode or the forgot-password panel lands on a usable sign-in form.
await page.click('#authToggleMode');
await page.evaluate(() => openForgotPassword());
await page.evaluate(() => signOut()); await wait(500);
check('forgot-password panel closed on sign-out', await page.isVisible('#authMainPanel') && !(await page.isVisible('#authForgotPanel')));
const s = await btnState();
check('back in sign-in mode', !s.disabled && s.text === 'Enter →' && await page.isVisible('#authEmail'), JSON.stringify(s));
// A wrong password still re-enables the button.
await page.evaluate(() => { authMode = 'signin'; });
await page.fill('#authEmail', ''); await page.click('#authSubmitBtn'); await wait(300);
check('error re-enables the button', !(await btnState()).disabled);
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
