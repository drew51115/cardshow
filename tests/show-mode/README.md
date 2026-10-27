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
node case-scan.e2e.mjs "iPhone 13"           # Phase 3: case scan A–D (also "Pixel 7")
node add-cards.e2e.mjs "iPhone 13"           # Add cards sheet: one card, type it in, spreadsheet
node join-show.e2e.mjs "iPhone 13"           # Seller self-join + the Show Mode gate
node show-directory.e2e.mjs "iPhone 13"      # Show Directory (platform owner) + seller show requests
node show-status.e2e.mjs "iPhone 13"         # Show status follows the dates (Upcoming / Active / Past)
node images.e2e.mjs "iPhone 13"              # Phase 4: card images, catalog ids, share-card photo + handle opt-in
node card-image.test.mjs                     # netlify/functions/card-image.js with CardSight stubbed (no browser)
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
psql -d cs_test -f ../../supabase/migrations/20261027120000_seller_self_join.sql
psql -d cs_test -f self-join.test.sql
psql -d cs_test -f ../../supabase/migrations/20261028120000_show_directory.sql
psql -d cs_test -f show-directory.test.sql
psql -d cs_test -f show-status.test.sql      # runs 20261029120000_show_auto_status.sql itself
psql -d cs_test -f show-mode-images.test.sql # runs 20261030120000_show_mode_images.sql itself (twice)
psql -d cs_test -f delete-show.test.sql      # runs 20261031120000_delete_show.sql itself (twice)
```
