# Show Mode tests

Browser tests run app.html against an in-page fake of Supabase (`mock-supabase.js`) that
implements `record_sale` / `void_sale` with the same rules as the SQL, returns network
errors while the browser is offline, and enforces the ledger's unique `client_sale_id`.
`mock-supabase-legacy.js` is the same fake with the Show Mode migration missing.

```bash
cd tests/show-mode && npm install
python3 -m http.server 8765 --directory ../..   # serve the repo root, in another terminal
node show-mode.e2e.mjs "iPhone 13"
node show-mode.e2e.mjs "Pixel 7"
node show-mode-legacy.e2e.mjs
```
Set `CHROMIUM_PATH` to use a specific Chromium (the cloud container has `/opt/pw-browsers/chromium`).
Each line prints PASS or FAIL. The camera is Chromium's fake device.

Database tests (Postgres 16, no Supabase needed; `supabase-stub.sql` stands in for the
`auth` and `storage` schemas and the existing tables):
```bash
createdb cs_test
psql -d cs_test -f supabase-stub.sql
psql -d cs_test -f ../../supabase/migrations/20261023120000_show_mode_sales.sql
psql -d cs_test -f sales.test.sql
```
