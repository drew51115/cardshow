# CardShow — Claude Code Context

## Project Overview
CardShow is a sports card show inventory platform connecting buyers, sellers, and show organizers. Built as standalone HTML files, deployed at https://getcardshow.com via Netlify (GitHub auto-deploy).

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework, no npm
- **Backend:** Supabase (postgres) — connected via CDN client in app.html and seller-browse.html
- **Hosting:** Netlify — auto-deploys from GitHub main branch
- **Domain:** getcardshow.com

## File Structure
```
index.html                        → Landing/marketing page (formerly landing.html)
app.html                          → Main platform — seller/admin/buyer views (formerly index.html)
show.html                         → Public show page (URL hash-encoded inventory)
seller-browse.html                → Buyer-facing seller storefront (QR scan destination)
_redirects                        → Netlify routing rules
netlify.toml                      → Disables pretty URLs (critical for show.html hash routing); functions = "netlify/functions"
netlify/functions/psa-lookup.js   → Serverless: POST {cert, grader} → normalized card object (PSA + CGC APIs)
netlify/functions/vision-scan.js         → Serverless: POST {image, mediaType} → normalized card object via Claude vision (Sprint 2)
netlify/functions/scan-card.js           → Serverless: POST {image_base64, media_type} → structured card object + per-field 0-1 confidence, used by Photo Scan & Card Fingerprinting (Scan-to-Sell POS + Manual Sale modal); separate from vision-scan.js because this prompt distinguishes a slab's cert number from the card's own printed serial number
netlify/functions/trading-card-lookup.js → Serverless: POST {query, sport?} → card search results from Trading Card API (Sprint 3); write-through cache via card_search_cache table (7-day TTL)
netlify/functions/invalidate-search-cache.js → Serverless: POST {query} → deletes matching rows from card_search_cache; protected by x-invalidate-secret header
netlify/functions/trade-og.js            → Serverless: GET /trade/:id → OG-tagged HTML for social crawlers, redirects humans into trade-zone.html (Trade Zone Phase 5)
netlify/functions/expire-trade-posts.js  → Scheduled (hourly, see netlify.toml): calls expire_stale_trade_posts() RPC to hide stale trade_posts from the live board
.env.example                             → Placeholder env vars for all keys
downloads/                               → Static file downloads served by Netlify
downloads/CardShow_Inventory_Template.xlsx → Pre-filled inventory template (13 example rows); linked from landing page and footer
downloads/.gitkeep                       → Tracks empty directory in git
trade-zone.html                          → Trade Zone guest quick-post + board + trade flow (standalone, lightweight — see "Trade Zone" section)
trade-board.html                         → Trade Zone venue-monitor live board + ?report=1 organizer report mode
js/trade-zone.js                         → Guest auth, post/board/propose/confirm/claim logic for trade-zone.html
js/trade-board.js                        → Realtime board rendering + report aggregation for trade-board.html
js/trade-share.js                        → Phase 4 canvas compositor + Web Share API for the branded trade graphic
supabase/migrations/20260825120000_trade_zone.sql → Trade Zone schema, storage buckets, RLS, and RPC functions — run in Supabase SQL editor
CLAUDE.md                         → This file
```

## Supabase Configuration
- **Project URL:** set in app.html / show.html / seller-browse.html (Supabase project `qtnqawqlmttogwnjieky`)
- **Anon key:** publishable key hardcoded in HTML files — intentionally public per Supabase security model (RLS governs access)
- **Client:** Loaded via CDN in `<head>` of app.html and seller-browse.html

## Database Schema
```sql
sellers       — id (uuid PRIMARY KEY = auth.uid()), handle, display_name, whatsapp,
                instagram, email, created_at
shows         — id (text), name, date, location, status, access_code, published_at, created_at,
                city (text), state (text), venue (text)
show_sellers  — show_id, seller_id (uuid → sellers.id), table_number (junction)
inventory     — id (uuid), seller_id (uuid → sellers.id), card_title, player, year,
                card_set, parallel, grader, grade, cert_number, condition, price,
                status, location, item_type, product_type, created_at, updated_at,
                fingerprint (text, indexed — see "Pending DB Migrations"),
                detected_confidence (jsonb — raw scan-card.js confidence object, audit trail only)
show_inventory — show_id, card_id (junction)
admins        — id (uuid PRIMARY KEY REFERENCES auth.users) — admin identity gate
show_floor_transactions — id (uuid), created_at, sold_at (timestamptz),
                sold_price, asking_price, price_delta (generated), payment_method,
                source (text NOT NULL DEFAULT 'platform', CHECK IN
                        ('platform','manual','community_report','social_extract')),
                inventory_id (→ inventory.id nullable), card_title, player, year,
                card_set, card_number, parallel, grader, grade, cert_number,
                condition, item_type, sport,
                card_fingerprint GENERATED (7-field:
                  lower(player)|year|lower(set)|lower(cardNumber)|lower(parallel)|grade|lower(grader)),
                seller_id (→ sellers.id nullable), seller_handle,
                show_id (→ shows.id), show_name, show_date, show_location,
                show_city, show_state, table_number,
                is_test (bool default false), api_eligible (bool default true),
                data_version (int default 1)
                IMMUTABLE — 4 RLS policies: SELECT permissive, INSERT permissive,
                UPDATE restrictive (USING false), DELETE restrictive (USING false)
```

## Supabase Persistence Status — All Complete
- ✅ Inventory — fetch on login, insert (add card), update (edit card + mark sold), upsert (CSV import)
- ✅ Seller profiles — display_name, whatsapp, instagram saved and loaded on login
- ✅ Shows — create, edit, delete (cascades to show_sellers + show_inventory)
- ✅ Show sellers — authorize, remove, table numbers (ascSetTable, setTableNumber, autoAssignTables)
- ✅ Show inventory — publish writes to show_inventory junction table
- ✅ seller-browse.html — fetches live inventory from Supabase on QR scan
- ✅ Phase 2 email auth — Supabase email + password auth
- ✅ Sold tracking columns — sold_price, payment_method, sale_notes, sold_time on inventory table (requires DB migration below)

## Auth Status — Phase 2 Deployed
- **Current:** Supabase email + password auth via `supabase.auth.signUp()` / `signInWithPassword()`
- **Session persistence:** Intentionally disabled — `db.auth.signOut()` runs on every page load so the login page always shows on fresh navigation. Sellers log in each visit.
- **Seller records:** linked to `auth.uid()` in the sellers table
- **⚠ RLS policies:** still using permissive `using (true)` — tightening to `auth.uid() = seller_id` is the next priority

## Current RLS Policies (Needs Tightening)
All tables currently use permissive `using (true)` / `with check (true)`.
Next step: replace with `auth.uid() = seller_id` for inventory, `auth.uid() = id` for sellers.

## Pending DB Migrations (run in Supabase SQL editor)
Required for sold tracking to persist:
```sql
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS sold_price     numeric,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS sale_notes     text,
  ADD COLUMN IF NOT EXISTS sold_time      text;
```

Required for sealed product / lot support:
```sql
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS item_type    text DEFAULT 'card',
  ADD COLUMN IF NOT EXISTS product_type text;
```

Required for per-admin show isolation:
```sql
ALTER TABLE shows ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users;
UPDATE shows SET created_by = '<your-admin-uuid>' WHERE created_by IS NULL;
CREATE INDEX IF NOT EXISTS shows_created_by_idx ON shows (created_by);
```
After migration, `loadShowsFromDB()` filters `WHERE created_by = _currentAdminUid` so each admin only sees their own shows. `showToDbRow()` stamps `created_by` on every upsert. `window._currentAdminUid` is set on admin login and cleared on sign-out.

Required for Photo Scan & Card Fingerprinting (duplicate detection — see that section below):
```sql
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS fingerprint          text,
  ADD COLUMN IF NOT EXISTS detected_confidence  jsonb;
CREATE INDEX IF NOT EXISTS idx_inventory_fingerprint ON inventory (fingerprint);
```
`cert_number` already existed on `inventory` before this migration (see schema above) — only `fingerprint` and `detected_confidence` are new. Until this migration runs, `checkDuplicateFingerprint()`'s `.eq('fingerprint', …)` query 404s/errors on the missing column; the function catches that and returns `null` (no warning shown), so the feature degrades gracefully rather than blocking a sale.

## Key Data Structures (in-memory runtime cache)
```js
inventory[]          // [{Seller, 'Card Title', Player, Year, 'Set ', Price, Status, item_type, product_type, _dbId, _shows: Set, ...}]
shows{}              // {showId: {id, name, date, location, status, accessCode, sellers: Set, tables: {}, publishedAt}}
sellerProfiles       // {handle: {displayName, whatsapp, instagram}}
currentRole          // 'seller' | 'admin' | 'buyer' | null
currentSeller        // handle string or null
buyerShowId          // active show for buyer view
activeShowId         // active show for admin/seller
_demoInventoryLoaded // bool — guards loadDemoInventory() from running more than once per session
_allSellerHandles    // string[] — DB cache of all registered seller handles; refreshed on admin login
_acItemType          // 'card' | 'sealed' | 'lot' — active item type in Add Card modal
```

## Demo / Sample Data — Buyer Only
- `loadDemoInventory()` — loads SAMPLE cards into `inventory[]` and calls `seedSampleShows()`. **Only called from `enterAsBuyer()`**, never on page load.
- `seedSampleShows()` — seeds the three demo shows into `shows{}` using the current inventory array. Only meaningful after `loadDemoInventory()` runs.
- `_demoInventoryLoaded` flag — prevents duplicate loads if buyer navigates back to show picker.
- `loginAsSeller()` and `loginAsAdmin()` both call `inventory.length = 0` and reset `_demoInventoryLoaded = false` to ensure demo cards never bleed into real sessions.

## Brand System
```css
--gold: #f5c842      /* primary accent */
--black: #07080c
--surface: #0d1018
--card: #131828
--border: #1e2640
--text: #e8eaf5
--muted: #5a6585
```
Fonts: Bebas Neue (headlines), DM Sans (body), DM Mono (labels/badges), Barlow Condensed (CTAs), Instrument Serif italic (subheadlines)

## Three User Roles
- **Seller** — email + password login → inventory management → profile (display name, WhatsApp, Instagram) → joins shows → QR code for table
- **Admin** — Supabase Auth + admins table gate → Shows dashboard (default) → All Inventory tab → create/manage shows, authorize sellers, assign tables, publish, share
- **Buyer** — guest → show picker → MLP Card Show demo (no code needed) → browse by sport/search → contact seller via WhatsApp or Instagram

## Key Functions Reference

### Supabase Persistence (app.html)
- `fetchSellerInventoryFromDB(handle)` — loads seller cards on login
- `insertCardToDB(card)` → returns UUID stored as `card._dbId`
- `updateCardInDB(card)` — edit card, mark sold
- `upsertCardsToDB(cards)` — CSV import batch
- `upsertShowToDB(show)` — create/edit show
- `deleteShowFromDB(showId)` — delete show (FK cascades to show_sellers + show_inventory)
- `addShowSellerToDB(showId, handle)` — authorize seller
- `removeShowSellerFromDB(showId, handle)` — deauthorize seller
- `updateTableNumberInDB(showId, handle, tableNum)` — table assignment
- `publishShowInventoryToDB(showId)` — write show_inventory rows
- `loadShowsFromDB()` — fetch all shows on admin login
- `refreshSellerHandlesCache()` — fetches all seller handles from DB into `_allSellerHandles`; called on admin login in parallel with loadShowsFromDB
- `cardToDbRow(card)` / `dbRowToCard(row)` — field mapping helpers (includes item_type, product_type)
- `parseShowLocation(str)` — parses "Venue, City, ST" → `{ venue, city, state }`. Used by `saveShow()` and `recordShowTransaction()` fallback
- `recordShowTransaction(card)` — async, fire-and-forget. Called from `sdConfirm()` after `updateCardInDB()`. Only fires when `activeShowId` is set. Uses `detectCardSport()` not `detectSport()`. Non-fatal on any error.

### Auth Functions (app.html)
- `submitAuth()` — async; handles seller sign-in/sign-up and admin sign-in via Supabase Auth
- `toggleAuthMode()` — switches auth overlay between sign-in and sign-up for sellers
- `loginAsSeller(handle)` / `loginAsAdmin()` / `enterAsBuyer()` / `signOut()` (async)

### Core UI Functions (app.html)
- `renderAdminShowsDashboard()` — Shows tab full render
- `switchAdminTab('shows'|'inventory')` — admin tab switcher (admin only; Report tab hidden from admin bar)
- `switchSellerTab('inventory'|'report')` — seller tab switcher; toggles table-wrap vs adminReportPanel
- `switchView(v)` — switches active view panel; safe to call from async code (guards `event?.target`)
- `publishSelectedToShow(showId)` — publish all authorized seller cards
- `buildShowPageUrl(showId)` — generates full hash-encoded show page URL (up to 50 cards)
- `buildShowQrUrl(showId)` — generates minimal metadata-only URL for QR codes (no card payload, avoids QR data limit)
- `copyShowPageLink(showId)` — opens share modal with URL
- `saveProfile()` — saves display name, WhatsApp, Instagram to memory + DB
- `saveShow()` / `deleteShow(showId)` — create/delete shows
- `ascSetTable(showId, handle, input)` — inline table assignment in dashboard
- `setTableNumber(showId, handle, value)` — sidebar table assignment
- `autoAssignTables(showId)` — auto-number all sellers 1–N
- `openAddCard()` / `closeAddCard()` / `saveAddCard()` — Add Card modal (supports card / sealed / lot item types)
- `acSetType(type)` — switches Add Card modal between 'card', 'sealed', 'lot' modes; shows/hides relevant fields
- `acToggle()` — shows/hides condition field based on grader selection (card mode only)

## Critical Implementation Notes
1. **show.html hash routing** — inventory encoded in URL hash via TextEncoder/TextDecoder. netlify.toml disables pretty URLs to prevent hash stripping on redirect. Hash must be decoded with TextDecoder, not escape/unescape (deprecated).
2. **sellers Set** — always a `Set`, never an array. Defensive check: `if (!(show.sellers instanceof Set)) show.sellers = new Set(show.sellers || [])` before .has()/.add()
3. **_dbId on cards** — cards get their Supabase UUID stored as `card._dbId` after insert. Required for updateCardInDB and publishShowInventoryToDB.
4. **.maybeSingle() not .single()** — always use maybeSingle() for queries that might return 0 rows. .single() returns 406 on empty result.
5. **No build step** — vanilla HTML only. No webpack, no npm, no compilation. Edit HTML files directly.
6. **Domain** — all absolute URLs use getcardshow.com. The old card-show.netlify.app domain is fully deprecated.
7. **RLS currently permissive** — all policies use `using (true)`. Do not tighten until confirming auth.uid() is reliably set in all write paths.
8. **Seller handle in DB** — inventory rows store seller_id (UUID), not handle. Always look up seller UUID by handle before querying inventory.
9. **switchView() is async-safe** — guards `event?.target` so it can be called from async functions without throwing. Previously calling it after any `await` would throw a TypeError and halt the calling function silently.
10. **No session restore on page load** — `db.auth.signOut()` runs on init. The login page always shows on fresh navigation. Do not re-add session restore without discussing UX implications first.
11. **Demo inventory is buyer-only** — `loadDemoInventory()` must only be called from `enterAsBuyer()`. Never call it on page load or from seller/admin login paths.
12. **partnershipLink visibility** — hidden in `loginAsSeller()` and `loginAsAdmin()`, restored in `signOut()`. Seller Profile button occupies the same nav-right area.
13. **Seller signup inserts sellers row immediately** — `signUp()` inserts the sellers row before checking `data.session`. When email confirmation is required, `data.session` is null and the code returns early; inserting first ensures the row exists by the time the user confirms and signs in. Unique violation (code 23505) is silently ignored.
14. **Authorize Sellers queries DB** — the show modal chip list fetches from `db.from('sellers').select('handle')` so all registered sellers appear, not just those with existing inventory. In-memory sellers (demo mode) are merged in.
15. **loginAsSeller loads shows from DB** — `loadShowsFromDB()` is called on seller login so `renderSellerShowsList()` can show authorized shows immediately.
16. **Stat strip is two-state** — 3 chips (Available / Ask Value / Graded) by default; Sold + Revenue chips appear only when `activeShowId` is set. Grid is 2-column so chips never overflow the sidebar.
17. **Supabase Site URL must be set** — Authentication → URL Configuration in Supabase dashboard must point to `https://getcardshow.com` or confirmation email links go to localhost.
18. **Admin sidebar seller dropdown uses DB cache** — `renderAdminShowsList()` reads `_allSellerHandles` (populated by `refreshSellerHandlesCache()` on login) rather than in-memory `inventory[]`. This ensures renamed/updated seller handles appear correctly. Falls back to inventory[] if cache is empty.
19. **QR codes use metadata-only URL** — `buildShowQrUrl()` encodes only show metadata + seller list (no card data). Full hash URLs with 50 cards exceed the QR data limit (~2–3KB) and cause silent rendering failure. The share link still uses the full `buildShowPageUrl()`.
20. **item_type on inventory cards** — values are `'card'` (default), `'sealed'`, `'lot'`. `product_type` stores the specific sealed format (e.g. 'Blaster Box'). Both fields are passed through `cardToDbRow`/`dbRowToCard` and require the DB migration above to persist.
21. **Seller-only sidebar visibility** — `#sellerUploadSection` (wraps the Upload Inventory drop zone + "+ Add Card" button) and `#sellerStatsRow` (the `.stats-row` stat chips) are hidden via `style.display='none'` in `loginAsAdmin()` and restored via `style.display=''` in both `loginAsSeller()` and `signOut()`. The admin sidebar shows only `#adminShowsPanel` (Quick Actions) and `#sellerQrPanel` is already correctly toggled via `.visible` class. This was a targeted display-toggle fix — the Shows dashboard, asc-header/asc-stats, and action bars in the main content area were not changed.
22. **Seller tab bar vs admin tab bar** — `#sellerTabBar` (My Inventory / Report) is shown only for sellers; `#adminTabBar` (Shows / All Inventory) is shown only for admins. `adminTabReport` is permanently hidden from the admin tab bar — sellers use `switchSellerTab('report')` for their dedicated Report tab. `loginAsSeller()` shows `#sellerTabBar` and defaults to inventory tab; `loginAsAdmin()` and `signOut()` hide it.
23. **Report show filter populates after DB load** — `populateReportShowSelector()` is called inside the `loadShowsFromDB().then()` callback in `loginAsSeller()` so the dropdown reflects the seller's authorized shows from Supabase, not just in-memory state at login time.
24. **`initSidebarState()` must be called on login** — Defined in app.html; adds `sidebar-open` on desktop (>768px) and removes it on mobile. Called from both `loginAsSeller()` and `loginAsAdmin()`. Sidebar HTML starts without `sidebar-open` class; desktop CSS shows sidebar unconditionally so the class only matters on mobile.
25. **Admin sidebar hidden on mobile** — `body.role-admin #mainSidebar { display: none !important }` in `≤599px` media query. Quick Actions (Create New Show, Back to Shows) are redundant with main content on mobile. Admin grid uses `grid-template-columns: 1fr` on mobile so main content fills full width.
26. **FAB (`#fabAddCard`) is seller-only** — Shown via `style.display=''` in `loginAsSeller()`, hidden in `loginAsAdmin()` and `signOut()`. Only visible at `≤767px` via CSS. Black background + gold border + gold "+" text for maximum contrast against dark UI. A secondary stacked FAB for Bulk Scan was tried and then removed — all card-add actions on mobile (including Bulk Scan, via the shortcut link in `#ac_scan_row`) now live behind this single primary FAB → Add Card modal, rather than multiple competing entry points.
27. **Comp search includes parallel** — `comp-lookup.js` search query: `[player, year, cardSet, parallel].filter(Boolean).join(' ')`. Cache fingerprint: `player|year|cardSet|cardNumber|parallel|grade|grader`. Both changes ensure autos/variants get correct prices instead of base card prices.
28. **show_floor_transactions is IMMUTABLE.** Four RLS policies: SELECT + INSERT permissive, UPDATE + DELETE restrictive (USING false). Corrections are new rows, never edits. Never add permissive UPDATE or DELETE policies to this table.
29. **recordShowTransaction() must never be awaited from sdConfirm().** Fire-and-forget. Sold confirmation UI must complete instantly.
30. **card_fingerprint on show_floor_transactions is 7-field format** matching `price_cache` exactly — joinable without transformation.
31. **detectCardSport() used in recordShowTransaction()** — not `detectSport()`. `detectSport()` is UI-only. `detectCardSport()` is API routing with full TCG keyword detection.

## Cert Scanner — Sprint 1 + 2 Architecture (Shipped)

### Scan Cascade (full, Sprint 1 + 2)
```
openCertScanner()
  └─ _enterPhotoMode() immediately — skips barcode phase, goes straight to photo capture
  └─ startScannerCamera()
       ├─ BarcodeDetector API available? (Chrome/Android)
       │    └─ getUserMedia → video.srcObject → startNativeScan() (250ms polling)
       │         └─ handleBarcodeDetected(raw)
       └─ No BarcodeDetector? (iOS Safari, Firefox)
            └─ startZXingScan()
                 └─ lazy-load @zxing/library@0.20.0 from jsdelivr (unpkg fallback)
                 └─ ZXing.BrowserMultiFormatReader.decodeFromVideoDevice(null, video, cb)
                      └─ handleBarcodeDetected(raw)

handleBarcodeDetected(raw)
  └─ parseCertBarcode(raw) → { cert, grader }   (PSA 8-9 digits, CGC 10 digits, SGC 7 digits)
       └─ lookupCert(cert, grader)
            └─ POST /.netlify/functions/psa-lookup { cert, grader }
                 ├─ 429 rate limit → retry 3× with 1s/2s/4s backoff; show Retry button on client
                 └─ fillFormFromScan(card) → reads DOM after fills → buildCardTitle() → .scan-filled highlight

Seller taps "📷 Take Photo"
  └─ capture video frame → canvas → JPEG 85% → max 1024px → base64
       └─ _callVisionScan(base64, mediaType)
            └─ POST /.netlify/functions/vision-scan { image, mediaType }
                 ├─ success → fillFormFromVision(card, result)
                 │    ├─ cardTitle NOT in fieldMap — always synthesized via buildCardTitle()
                 │    ├─ confidence color coding (green/amber/red left border)
                 │    ├─ _showVisionConfirmBanner() — "📷 Auto-detected · review & confirm"
                 │    └─ analytics toast ("✓ Card identified — N fields auto-filled")
                 ├─ low_confidence → toast + "Try Again" / "Search by name" fallback buttons
                 └─ network error → retry up to 2× then fall through to manual entry
```

### Sprint 2 Vision Function (vision-scan.js)
- **Model:** claude-sonnet-4-6
- **Timeout:** 10 seconds (AbortController)
- **Two-prompt strategy:** sports prompt first; if sport is Pokemon/TCG, re-calls with TCG-specific prompt
- **Prompt A (sports):** extracts player, year, set, cardNumber, parallel, grader, grade, certNumber, sport, itemType, productType + confidence per field
- **Prompt B (TCG/Pokemon):** additionally extracts hp, rarity; finer-grained set/expansion detection
- **Confidence levels:** `high` (text clearly readable) / `medium` (inferred) / `low` (uncertain)
- **All-low guard:** if every confidence value is "low", returns `success: false, error: "low_confidence"` so client falls through to TCDB text search (Sprint 3 stub)
- **BGS slabs:** handled naturally — Claude reads the BGS label and returns `grader: "BGS"` + grade. This is the Sprint 4 BGS solution moved forward.

### Confidence Color Coding (app.html CSS)
| Level  | Visual |
|--------|--------|
| `high`   | Green left border `rgba(22,163,74,0.7)` |
| `medium` | Amber left border `rgba(245,158,11,0.7)` |
| `low`    | Red left border `rgba(239,68,68,0.7)` + red-tinted background |

Border removed automatically after 60 seconds or on `clearVisionData()`.

### buildCardTitle(card) — Sport-aware title generation
Called from `fillFormFromScan` (barcode) and `fillFormFromVision` (vision). Generates Card Title field from normalised scan fields. **Uses `String(val ?? '').trim()` for all fields** — Claude vision API returns `year` as an integer; calling `.trim()` on a number throws a TypeError that silently aborts title generation.
- **Sports:** `{year} {set} {player} {parallel}` → `"2024 Bowman Chrome Dylan Crews Fuchsia Refractor"`
- **Pokemon:** `{year} Pokemon {set} {name} #{cardNum} {rarity}` → `"2023 Pokemon Scarlet & Violet 151 Charizard ex #006/165 SIR"`
- **MTG:** `{year} Magic The Gathering {set} {name} {foil}` → `"2024 Magic The Gathering Bloomburrow Ral, Crackling Wit Foil"`
- **One Piece / Yu-Gi-Oh:** similar pattern with game prefix
- Game prefix is suppressed when PSA's set name already starts with the game name (avoids "Pokemon Pokemon Scarlet & Violet…")

### Netlify Functions
- **`psa-lookup.js`** — POST `{ cert, grader }` → `{ player, cardSet, year, cardNum, parallel, grade, grader, certNum, sport, rawTitle }`. Routes PSA/SGC to PSA API, CGC to CGC API. Retries 3× on 429. Requires `PSA_API_TOKEN` and `CGC_API_TOKEN` env vars set in Netlify dashboard.
- **`vision-scan.js`** — POST `{ image, mediaType }` → `{ success, card, isTCG, promptVariant, rawResponse }`. Calls Claude claude-sonnet-4-6 via Anthropic API. Two-prompt strategy (sports then TCG). 10s timeout. Requires `ANTHROPIC_API_KEY` in Netlify dashboard.

### Environment Variables (set in Netlify dashboard)
| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL — injected into HTML at build time via sed |
| `SUPABASE_ANON_KEY` | Supabase publishable anon key — injected at build time; marked `SECRETS_SCAN_OMIT_KEYS` |
| `PSA_API_TOKEN` | PSA PublicAPI Bearer token for cert lookups |
| `CGC_API_TOKEN` | CGC API Bearer token for card cert lookups |
| `TCGAPIS_KEY` | Reserved for Sprint 3 TCG price lookups |
| `ANTHROPIC_API_KEY` | Claude API key for vision-scan.js (Sprint 2) |
| `TRADING_CARD_API_KEY` | Trading Card API key for live card DB autocomplete (Sprint 3) — add in Netlify dashboard → Site settings → Environment variables once approved at tradingcardapi.com/early-access |
| `CACHE_INVALIDATE_SECRET` | Random secret protecting `/.netlify/functions/invalidate-search-cache` — set to output of `openssl rand -hex 24`; pass as `x-invalidate-secret` request header |
| `POKEMON_TCG_API_KEY` | pokemontcg.io API key — optional; raises rate limits. Free tier works without it. Register at dev.pokemontcg.io |
| `CARDHEDGE_API_KEY` | Card Hedge key — primary sports card comp source. cardhedge.com |
| `CARDHEDGE_ENABLED` | Set to `false` to disable Card Hedge without removing the key (default: `true`) |
| `CARDSIGHT_API_KEY` | CardSight AI key — secondary sports card comp source. Free tier: 750 calls/month. cardsight.ai/for-developers |

### Credential Injection (no build step workaround)
Supabase URL and anon key are **not** hardcoded in tracked files. `netlify.toml` has a `command` that runs `sed` to replace `SUPABASE_URL_PLACEHOLDER` / `SUPABASE_ANON_KEY_PLACEHOLDER` in all three HTML files at deploy time. `SECRETS_SCAN_OMIT_KEYS = "SUPABASE_URL,SUPABASE_ANON_KEY"` prevents Netlify's secrets scanner from blocking the build on the injected values (they are intentionally public publishable keys).

### Key Scanner Functions (app.html)
- `openCertScanner()` / `closeCertScanner()` — open/close overlay; goes straight to photo mode (`_enterPhotoMode()`) on open
- `_enterBarcodeScanMode()` / `_enterPhotoMode()` — UI state toggles between barcode aim guide and card aim guide
- `startScannerCamera()` — branches on BarcodeDetector availability; starts camera for photo capture
- `startNativeScan()` — BarcodeDetector polling every 250ms
- `startZXingScan()` — loads @zxing/library@0.20.0 UMD from CDN (jsdelivr → unpkg fallback)
- `stopScannerCamera()` — clears interval/timeout, resets ZXing reader, stops all MediaStream tracks
- `parseCertBarcode(raw)` — digit-length heuristic: PSA 8-9 digits, CGC 10 digits, SGC 7 digits; URL pattern fallback
- `lookupCert(cert, grader)` — POST to psa-lookup; on 429 shows Retry button wired to re-call lookupCert
- `buildCardTitle(card)` — sport-aware title builder; uses `String(val ?? '')` to handle integer `year` from vision API
- `fillFormFromScan(card, cert, grader)` — barcode result: populates Add Card fields via forEach, then reads DOM values into `buildCardTitle()` for title; `.scan-filled` highlight
- `fillFormFromVision(card, result)` — vision result: `cardTitle` excluded from fieldMap; title always synthesized via `buildCardTitle()`; confidence color coding, confirm banner, analytics toast
- `_applyVisionConfidence(el, level)` — applies vision-high/medium/low CSS class; auto-removes after 60s
- `_showVisionConfirmBanner(filledFields)` — injects banner above form with legend and "Clear scan data" link
- `clearVisionData()` — removes banner and clears all vision-filled form fields
- `scanTakePhoto()` — captures canvas frame, dispatches to `_callVisionScan` (no scan limit check)
- `scanVisionRetry()` — resends last captured image on retry
- `scanFallbackToSearch()` — closes scanner, focuses Player input for TCDB text search (Sprint 3 stub)
- `lookupManualCert()` — manual cert # + grader dropdown fallback

### Known Constraints
- PSA API free tier has very low rate limits (~10 req/hr). Upgrade PSA API account tier if 429s occur frequently at shows.
- ZXing CDN load adds ~1-2s delay on first open (library is ~400KB). Cached on subsequent opens within the session.
- `@zxing/browser` ships ESM only — no UMD bundle. Must use `@zxing/library` for CDN UMD loading.
- Vision API adds ~1-3s latency per scan. Showing the loading overlay keeps UX responsive.
- Claude vision is good at reading PSA/CGC/BGS labels and raw card fronts; accuracy drops for small text, glare, or very dark backgrounds.

## Sprint 3 — Live Card Database Autocomplete + Full Cascade Wiring

### Full Three-Stage Cascade (Sprints 1 + 2 + 3)
```
["SCAN CARD" button tapped on Add Card modal]
        ↓
Open scanner overlay → _enterPhotoMode() immediately (data-state="photo")
Camera starts live — barcode detection runs in background
        ↓
Barcode found (background)?
  YES → POST /psa-lookup → fillFormFromScan() → DOM-read title → confirm toast → DONE

Seller taps "📷 Take Photo"
        ↓
Canvas capture → JPEG 85% / max 1024px → data-state="processing"
Progress bar animates → POST /vision-scan (AbortController 10s)
        ↓
Vision result?
  HIGH confidence (3+ fields) → fillFormFromVision() → confirm banner → analytics toast → DONE
  MEDIUM/LOW → pre-fill + highlight low-confidence fields + show "Search by name" CTA
  ALL LOW / failure → _handleVisionFailure() → up to 2 retries → fall through
        ↓
"Search by name" tapped OR 2 vision failures
        ↓
closeCertScanner() → focus #ac_search input → toast: "Type the card name to search"
        ↓
acSearch() → debounced 250ms → POST /trading-card-lookup
  stub: true → silent fallback to local CARD_DB
  stub: false → live Trading Card API results (up to 8)
        ↓
Seller selects result → acSelect() → db-filled green borders → toast → focus price → DONE
```

### Overlay State Machine
`data-state` on `#certScannerOverlay`:
- `photo`    — card aim guide visible, "📷 Take Photo" button active, camera live (default on open)
- `processing` — vision loading overlay shown, AbortController active

Cancel at each state:
- `photo`: X button closes overlay
- `processing`: AbortController.abort() fires, toast "Scan cancelled", overlay closes

### Trading Card Lookup Function (trading-card-lookup.js)
- **Endpoint:** POST `{ query, sport? }` → `{ stub: bool, results: [...], fromCache?: bool, source?: string }`
- **Routing logic (in priority order):**
  1. `TRADING_CARD_API_KEY` set → Trading Card API for all sports + TCG (3M+ cards); cache key `"tradingcardapi:"`
  2. No `TRADING_CARD_API_KEY` → Pokémon TCG API + PriceCharting run in **parallel** via `Promise.all`; results merged (Pokémon first, deduped by id, capped at 8); cache key `"auto:"`
  3. Both parallel APIs return empty → `stub: true` (client falls back to local CARD_DB)
- **Trading Card API mode:** `GET https://api.tradingcardapi.com/v1/cards?filter[name]=...&page[limit]=8` with `Authorization: Bearer` and `Accept: application/vnd.api+json`. 5-second timeout.
- **PriceCharting fallback mode:** `GET sportscardspro.com/api/products?t=TOKEN&q=...` → up to 8 results. Parses the `name` + `console-name` fields into structured `{ player, year, cardSet, parallel }` via `parsePCProduct()`. `cardNumber` and `imageUrl` are null in this mode.
- **`parsePCProduct(product)`** — extracts year via regex, uses `console-name` as set, strips known parallel terms to isolate player name.
- Returns normalized objects: `{ id, player, year, cardSet, cardNumber, sport, parallel, imageUrl, rawTitle? }`
- **Cache:** results written to `card_search_cache` (Supabase) after successful live call; read on next identical query within 7 days. Cache key prefixed by source (`tradingcardapi:` or `auto:`). Requires `SUPABASE_SERVICE_KEY`. Cache write is non-blocking.

### Card Search Cache (card_search_cache table)
- **TTL:** 7 days, keyed by `query_key` = `"tradingcardapi:{normalized_query}"` (lowercased, whitespace-collapsed)
- **Schema:** `query_key text PK, results jsonb, source text, fetched_at timestamptz`
- **Cache hit response:** adds `fromCache: true, source: "tradingcardapi"` to the JSON response
- **Invalidation:** `/.netlify/functions/invalidate-search-cache` — POST `{ query }` with `x-invalidate-secret` header; deletes all rows with `query_key ILIKE %{normalized}%`; protected by `CACHE_INVALIDATE_SECRET` env var
- **Debug:** `window.CARDSHOW_DEBUG = true` shows `⚡ from cache · tradingcardapi` note at bottom of dropdown on cache hits
- **`buildQueryKey(rawQuery, source)`** — normalises to lowercase + collapsed whitespace, prefixes source

### Live Autocomplete (app.html)
- **Trigger:** 3+ characters in `#ac_search`, 250ms debounce
- **Spinner:** right-side inline spinner in search input while fetching
- **Dropdown:** up to 8 results — player name + year + sport header row, set + card # meta row
- **Keyboard nav:** ArrowUp/Down to move focus, Enter to select, Escape to close
- **On select:** fills player, year, set, card #, parallel with green `db-filled` border (8s); focuses price input; toast "Card details filled in — add grade and price"
- **No results:** "No matches found — enter details manually" item
- **Debug note:** `window.CARDSHOW_DEBUG = true` reveals "Using local card database" note under the input (stub mode) or "⚡ from cache" note at dropdown bottom (cache hit)

### Scan History (session-only)
- `_scanHistory[]` — last 5 scanned cards, stored in memory, cleared on `signOut()`
- Rendered as chips below scan usage bar: `#scanHistorySection` / `#scanHistoryList`
- Each chip shows `year player grader grade` truncated to 36 chars
- Clicking a chip calls `_reopenFromHistory(idx)` — opens Add Card and pre-fills all fields from the stored scan data
- Useful when seller has two copies of the same card to add

### New Functions (app.html)
- `acSearch(q)` — upgraded: 3+ char trigger, 250ms debounce, calls live function, falls back to CARD_DB
- `_acDoSearch(q)` — async: POSTs to trading-card-lookup, normalizes results, renders dropdown
- `acKeyNav(e)` — arrow key + enter + escape navigation for dropdown
- `acSelect(idx)` — fills form fields with `db-filled` green borders, focuses price
- `_acProgressStart()` / `_acProgressDone()` — animates slim gold progress bar at modal top
- `_addScanHistory(cardData)` / `_renderScanHistory()` — manage session scan history chips
- `_reopenFromHistory(idx)` — re-opens Add Card pre-filled from a history entry

### Seller Report Tab (app.html)
- **`#sellerTabBar`** — tab bar shown only for sellers (`📋 My Inventory` / `📊 Report`); hidden for admin and on sign-out
- **`switchSellerTab(tab)`** — `'inventory'`: shows `.table-wrap`, hides `#adminReportPanel`; `'report'`: hides `.table-wrap`, shows `#adminReportPanel`, calls `populateReportShowSelector()` + `updateReport()`
- **`#rptShowFilter`** — dropdown scoped to seller's authorized shows (populated by `populateReportShowSelector()`); default "All shows (lifetime)"; updates report on change
- **`populateReportShowSelector()`** — reads `shows{}` filtered to `currentSeller`, sorted by date; idempotent (skips if options unchanged); called from `switchSellerTab('report')` and after `loadShowsFromDB()` in `loginAsSeller()`
- **`updateReport()`** — now reads `rptShowFilter` value and scopes sold cards to that show's `_shows` Set (or all-time when blank); also renders best/worst delta cards and top 5 by revenue
- **Best sale / Most discounted** — two new stat cards in `.report-grid-2col`; show card title + delta vs. ask price for the highest-gain and highest-discount sold card in scope
- **Top 5 by revenue** — `#rptTopCardsSection` / `#rptTopCards`; sorted descending by `SoldPrice`; rendered between payment breakdown and transaction log
- **`exportReportCSV()`** — downloads filtered sold cards as CSV; filename includes show name (or "all-time") and date; columns: Card Title, Player, Year, Set, Grade, Grader, Ask Price, Sold Price, Delta, Payment Method, Sale Time, Notes
- **`adminTabReport`** is permanently hidden from the admin tab bar — admins access All Inventory only; sellers use `sellerTabBar` for their own report

## Comp Pricing — Card Hedge + CardSight AI + PriceCharting + TCG API

### Architecture
- `netlify/functions/comp-lookup.js` — POST `{ cards: [...] }` → `{ results: [...] }`
- Cards processed **sequentially** (for...of, never Promise.all) to respect PriceCharting's 1 req/s limit
- Sport routing:
  - Pokemon → pokemontcg.io (TCGPlayer market prices), fallback to TCG API
  - Other TCG (MTG, Yu-Gi-Oh, etc.) → TCG API
  - Sports cards → **Card Hedge** (primary, if enabled) → **CardSight AI** → **PriceCharting** (fallback)
- Feature flag: `const CARDHEDGE_ENABLED = process.env.CARDHEDGE_ENABLED !== 'false' && !!process.env.CARDHEDGE_API_KEY`

### Card Hedge — Primary Sports Card Comp Source
- `CARDHEDGE_API_KEY` env var (set in Netlify). `CARDHEDGE_ENABLED=false` disables without removing the key.
- Base URL: `https://api.cardhedger.com`. Auth: `X-API-Key: {key}` (NOT Bearer).
- **Three-step flow:**
  - Step 1: `POST /v1/cards/card-match` → `card_id` (4s timeout). Body: `{ query: "year set player parallel grader grade" }` — single free-text string in `query` field (NOT `description`; NOT structured object — 422 if wrong). Response: `{ match: { card_id, confidence: 0-1 float, player, prices: [{grade, price}], reasoning } }`. `card_id` and prices are nested under `match`. If `prices[]` has the correct grade tier, price is extracted immediately and `card-fmv` is skipped entirely. On failure: `POST /v1/cards/90day-prices-by-grade` with `{ query, grade: float, grader }` → returns price directly (early return, 4s timeout).
  - Step 2: `POST /v1/cards/card-fmv` with `{ card_id, query }` → only called when `card-match` succeeded but `prices[]` was empty. `compPrice` from `fmv`/`price`/`fair_market_value` field. 4s timeout.
  - Step 3: `POST /v1/cards/comps` with `{ card_id, query }` → recent sales array (3s timeout, non-fatal). Sales normalised to `{ price, date, source, url, image, isBin }`.
- Confidence is a 0–1 float from the match response, mapped to A/B/C/D (≥0.9→A, ≥0.7→B, ≥0.5→C, <0.5→D). **D confidence suppressed** — falls through to CardSight.
- `extractCardHedgePrice(prices, card)` — selects correct grade tier from `prices[]`: exact label match (`"PSA 10"`), then closest same-grader grade, then Raw fallback.
- `match.reasoning` maps to `priceExplanation` displayed in buyer modal.
- Source label in buyer modal: `"Market value · Card Hedge (A confidence)"` when confidence A/B/C; `"Market value · Card Hedge"` otherwise.
- `priceExplanation` rendered as small muted text below source label in buyer modal when present.
- Returns normalised `{ stub, compPrice, lowPrice, highPrice, recentSales[], source: 'cardhedge', matchedCard, confidence, priceExplanation }`.
- **Do NOT use** `card-search` or `card-details` endpoints — they return only TOP grade prices and are not suitable for comp pricing.

### CardSight AI — Secondary Sports Card Comp Source
- `CARDSIGHT_API_KEY` env var (set in Netlify). Free tier: 750 calls/month — 24h `price_cache` TTL limits redundant calls significantly.
- **Three-step flow** (confirmed by CardSight support):
  - Step 1: Tiered catalog search — up to 4 attempts with progressively broader params. Confirmed params from CardSight support: `number=` (exact match), `releaseName=` (partial CI), `attributeShortName=` (exact case-sensitive: `RC`, `AU`), `year=`, `name=` (partial, player name), `sort=`/`order=`.
    - Attempt 1: `name+year+number` only (take=5) — `number=` is **isolated** from other filters; combining with `releaseName=`/`attributeShortName=` causes CardSight 500s for certain card numbers (e.g. RA-PS, BPA-PS2). Skipped when no card number present.
    - Attempt 2: `name+year+releaseName+attributeShortName` no number (take=10)
    - Attempt 3: `name+year+releaseName` no attribute (take=15)
    - Attempt 4: `name+year` only (take=25) — broadest fallback
  - 500/404 responses use `continue` (try next attempt); 401/429 `break` the loop. Full failing URL + error body logged on any non-ok for CardSight support reproduction.
  - Step 2: Parallel resolution — `GET /v1/catalog/cards/{card_id}` → list of parallels with `id` and `name`. Scores each parallel name against seller's `card.parallel` (word overlap + print run match); selects `parallel_id` when ≥1 word overlap. Non-fatal: timeout/404 skips to aggregate pricing. Only runs when seller has a parallel AND `parallel_id` is not already cached.
  - Step 3: `GET /v1/pricing/{card_id}?parallel_id=&period=&listing_type=both&limit=25` → `{ raw: { records }, graded: [{ company_name, grades: [{ grade_value, records }] }] }`. `period=all` when print run ≤100 (scarce parallels may have zero 90-day sales); `period=90d` otherwise. `parallel_id=` filters to matching parallel variant only.
- Auth: `X-API-Key: {CARDSIGHT_API_KEY}` (not `Authorization: Bearer`)
- All field accesses use optional chaining + fallback chains due to undocumented Swagger (`id ?? uuid ?? card_id`, `grade_value ?? grade ?? label ?? value`, `company_name ?? grader ?? label`, `raw?.records ?? raw?.sales ?? records ?? []`, etc.)
- `listing_type` filter accepts `'sold'`, `'completed'`, `'auction'`, `'fixed'`; records with absent field are also included as fallback.
- Catalog result selection: `scoreCatalogMatch(results, card)` scores all 10 candidates (take=10) and returns the highest-scoring card above a 40-point threshold. Scoring: year match 40 pts (mismatch disqualifies the candidate entirely), set/release name up to 30 pts (10 per matching keyword), solo-player bonus 15 pts (multi-player cards penalised -5 per slash), card number 10 pts exact / 5 pts partial, AUTO attribute 5 pts, player in name 5 pts. `release=` hint also passed to catalog endpoint to help narrow server-side results. `CARDSHOW_DEBUG` logs each candidate's score and the selected card.
- Expanded attribute scoring: ROOKIE (+15/-5), AUTO (+10/-10), REFRACTOR (+10), PATCH/RELIC/JERSEY (+10), league code match (+10, e.g. MLB-* for baseball), wrong league (-15). AUTO/ROOKIE checked against `cardTitle` field in addition to `parallel`. `cardTitle` now passed in both comp fetch calls (buyer `fetchBuyerComp` and seller `runCompCheck`).
- `extractReleaseName(cardSet)` maps set name to CardSight's `releaseName` keyword (40-entry signature table; **order matters** — more specific variants listed first, e.g. "Topps Chrome Update" before "Topps Chrome", "Bowman Chrome Draft" before "Bowman Chrome"). Falls back to first long word. Self-test assertions run in `CARDSHOW_DEBUG` mode to catch mapping regressions.
- `inferManufacturer(cardSet)` maps set name to manufacturer: Topps/Bowman → `'Topps'`; Prizm/Donruss/Select/Mosaic/Contenders/Chronicles/Optic → `'Panini'`; Upper Deck; Fleer. Returns `null` when unknown. Added to attempt 2 and 3 params as `manufacturer=` so Topps Chrome queries never return Panini results even if `releaseName=` is imprecise.
- `deriveAttributeShortNames(card)` maps cardTitle/parallel to RC/AU codes; AU returned first (more pricing-specific).
- `scoreCatalogMatch()` is now a tiebreaker — results already pre-filtered by year/release/attr. Fast path on exact number match; then scores solo card (+20), player in name (+10), partial number (+8). No minimum threshold.
- **Exact number tie-break**: when `number=` returns multiple cards sharing the same number across different releases (e.g. Bowman Sterling + Topps Chrome + Triple Threads all sharing "RA-PS"), each is scored by `releaseName` word overlap against the seller's set. The highest-scoring release wins; first result is the safe default.
- **Draft Picks penalty**: `-30` in `scoreCatalogMatch()` when result's `releaseName` contains "draft picks" and seller's `cardSet` doesn't contain "draft". Prevents Prizm Draft Picks from winning over base Prizm on shared card numbers.
- Grade matching: finds exact `grade_value` match first, falls back to within ±0.5; falls back to raw sales for ungraded cards.
- `compPrice` computed as median of up to 5 most recent sale records.
- Returns normalised `{ stub, compPrice, lowPrice, highPrice, recentSales[], source: 'cardsight', matchedCard, parallelId, cardId, isBinOnly }`.
- `recentSales` — array of `{ price, date, source, url, image, parallelName, isBin }` up to 5 individual sale records sorted by parallel match score (see `scoreAndSortRecords`); `[]` for all other sources. `url` links to original eBay/marketplace listing.
- Buyer modal: sale rows with `url` render as tappable `<a>` links with `↗` gold icon; without URL fall back to `<div>`. BIN rows show a "BIN" badge in muted style.
- Source label in buyer modal: "Real sales data · CardSight AI" (completed sales) or "Current asking prices · CardSight AI" (`isBinOnly=true`).
- `scoreAndSortRecords(records)` — returns `{ rows, isBinOnly }`. Separates completed sales (sold/completed/auction) from BIN (fixed) listings. Completed sales used as primary; BIN used as fallback only when no completed sales exist. Parallel normalisation strips Auto/Autograph/RC/Rookie from seller parallel before word matching — CardSight tracks autograph status at card/set level, not parallel level. Refractor is normalised out then re-added to ensure it still matches CardSight parallel names. Seller-parallel variables computed once in the outer closure.
- Fallback: if CardSight returns stub or no `compPrice`, falls through to PriceCharting.

### PriceCharting API — Fallback for Sports Cards
1. **Search:** `GET sportscardspro.com/api/products?t=TOKEN&q=<player year set>` → get `product.id`
2. **Price:** `GET sportscardspro.com/api/product?t=TOKEN&id=<id>` → get grade-tiered price
- Prices returned in **pennies** — always divide by 100
- `buildPCQuery(card)` constructs `"player year set"` as one free-text string (documented format). Card number appended only when purely numeric (`/^\d+$/`) — alphanumeric codes like BPA-PS2, RA-PS, RCPA-PS are not in PriceCharting's index and cause false matches.
- Confirmed grade field names from official API docs: PSA 10 → `manual-only-price`, BGS 10 → `bgs-10-price`, CGC 10 → `condition-17-price`, SGC 10 → `condition-18-price`, Grade 9 → `graded-price`, Grade 8/8.5 → `new-price`, Grade 7 → `cib-price`, Ungraded → `loose-price`
- `scorePCResult(product, card)` scores PriceCharting results before selection — all returned products are scored and sorted; the highest score wins. Scoring: bracket variants like `[Image Variation]` / `[X-Fractor]` penalised -25 unless bracket content matches seller's parallel (+5); base cards (no brackets) get +15; exact card number match +20; different number tiebreaker -5; player name (both first AND last) in pre-# portion of product name +15; wrong player -20 (restricting to pre-# portion prevents "Josh Allen" matching "Allen & Ginter"); sport match via `console-name` field +20; cross-sport mismatch -40 (prevents Baseball Cards winning for Football card queries); year match (from console-name) +15 exact, -5 (±1yr), -15 (2-3yr), -30 (4+yr delta); subset keywords (image variation, rookie cup, award winner, variation, etc.) -15. `pcSportCategory(sport)` maps seller sport to PC console-name keyword.
- `selectPCPrice(p, card)` selects the correct tier; 0 is treated as noData (not $0 card); `loose-price` used as fallback with `gradeFallback: true` on result
- Retry with `player year` only when full query returns 0 products (set name token mismatch is a common miss cause)
- `fetchPCPrices(token, productId)` helper extracts the price fetch step — called for the initial product, and again for a retry product ID when the first match returns all-zero price data (`{}` in logs). Empty price data `{}` triggers a second search with `player+year` only and fetches prices for the new product ID.
- `PRICECHARTING_TOKEN` must be set in Netlify — degrades to `{ stub: true }` without it

### Rate Limiting
- `waitForPCRateLimit()` in comp-lookup.js enforces **1100ms minimum gap** between PriceCharting calls (server-side defence-in-depth; resets on cold start)
- **Primary guard is client-side**: `runCompCheck()` in app.html waits **1200ms between cards** for non-cached results — this is the real throttle since each card requires 2 API calls and Netlify functions are stateless

### TCG API
- `GET api.tcgapi.dev/v1/cards?q=...` with `Authorization: Bearer TCG_API_KEY`
- Returns `{ compPrice, lowPrice, highPrice, source: 'tcgapi', cardName, setName }`
- 6s timeout, graceful stub on any error

### Normalised Result Shape (all sources)
```js
{
  stub:         false,
  compPrice:    number,          // median or market price
  lowPrice:     number | null,
  highPrice:    number | null,
  recentSales:  [{ price, date, source }],  // CardSight only; [] for all others
  source:       'cardsight' | 'pricecharting' | 'pokemontcg' | 'tcgapi',
  matchedCard:  string | null,
  fromCache:    true,            // only on cache hits
}
```

### price_cache Table (Supabase)
- **TTL:** 24 hours, keyed by `card_fingerprint` (`player|year|set|cardNumber|parallel|grade|grader` lowercased)
- Cache hits return `{ fromCache: true }` — no API call, no delay needed
- `source` column distinguishes which API matched — query it to compare CardSight vs PriceCharting match rates
- `parallel_id` and `card_id` columns store CardSight stable catalog IDs; `getCachedIds()` reads these from stale rows (no TTL filter) so catalog search + parallel resolution are skipped on the next live call for the same fingerprint
- Requires `SUPABASE_SERVICE_KEY` (service role) in Netlify env vars
- Table must exist: run `SELECT to_regclass('public.price_cache');` in Supabase SQL editor; if null, run the CREATE TABLE SQL from the comp-check sprint output
- **Pending migration** — run in Supabase SQL editor to add new columns:
  ```sql
  ALTER TABLE price_cache
    ADD COLUMN IF NOT EXISTS parallel_id text,
    ADD COLUMN IF NOT EXISTS card_id text;
  ```

### Sport Detection (`detectCardSport(card)` — app.html)
- Separate from `detectSport()` (UI badges) — this routes API selection only
- Checks `card.Sport` first; falls back to keyword scan of title/set/player
- TCG keywords: pokemon, mtg, magic, yu-gi-oh, lorcana, one piece, dragon ball, digimon, scarlet, violet, base set, evolving skies, prismatic, obsidian, etc.
- Sport keywords (regex word-boundary): NFL/football/gridiron → Football; NBA/basketball/hoops → Basketball; NHL/hockey → Hockey; MLB/baseball → Baseball
- Returns `''` (empty string) for unrecognized cards — comp-lookup.js `inferSportFromPlayer()` handles inference; returning 'Baseball' here caused football cards to get wrong sport and score backwards
- Sport field is blank in seller inventory by default — inference handles it end-to-end

### Sport Inference (`inferSportFromPlayer()` — comp-lookup.js)
- Canonical sport inference function used in both `scorePCResult()` and `lookupComp()` routing
- Checks full names first (most precise: 'josh allen', 'ronald acuna'), then last-name fragments
- Football checked before basketball, basketball before baseball — prevents 'murray'/'jackson' defaulting to baseball
- Football: mahomes, allen, burrow, herbert, hurts, brady, manning, rodgers, prescott, stroud, purdy, young + full names
- Basketball: morant, wembanyama, flagg, tatum, jokic, giannis, embiid, booker, lillard, gilgeous + full names
- Baseball: trout, ohtani, judge, acuna/acuña, tatis, soto, betts, devers, skenes, mantle, mays, jeter, ripken + full names
- Returns null when genuinely unknown — sport penalty/bonus skipped rather than guessed wrong
- `lookupComp()` uses resolvedSport = card.sport || inferSportFromPlayer() for routing decisions (Pokemon vs TCG vs sports)

### runCompCheck(cards) — app.html
- Sequential card-by-card loop with progress bar + cancel button
- Shows time estimate at start: `~Ns` or `~N min` (1.2s/card conservative estimate)
- Progress bar: slim 3px gold bar + `"Checking comps… 14 of 47 cards · Player Name…"` (card name truncated to 32 chars)
- **Cancel:** `window._compCheckCancelled` flag; `cancelCompCheck()` sets it; checked at top of each loop iteration; shows partial summary if any results collected
- Cache hits skip the 1200ms delay (no API call made)

### Comp Check — Selection Scoping
- **`getCompCheckCards()`** — returns checked cards when any checkboxes are checked; falls back to all non-sold inventory when nothing is checked. The "💲 Check Comps" button calls this instead of always using all available cards.
- Checkbox selection now serves three purposes: show inventory inclusion, bulk delete, and comp check scoping.

### Cancelled Infrastructure (do not build)
- `netlify/functions/sync-pricecharting.mjs` — cancelled; API-only approach used instead
- `pricecharting_prices` Supabase table — not needed; only `price_cache` is used

## Bulk Scan — Supabase Edge Function + Review UI (Phase 1 + 2)

Lets a seller photograph an entire showcase/tray and get every visible card identified in one Claude vision call, instead of scanning cards one at a time via the cert scanner. This is a **separate feature from the Cert Scanner** (which stays as-is) — it lives in a Supabase Edge Function, not a Netlify function, because it needs the seller's Supabase Auth JWT validated server-side before the image is ever touched.

### Endpoint
- **Path:** `supabase/functions/bulk-scan/index.ts` (Deno). Local: `supabase functions serve bulk-scan`. Deployed: `{SUPABASE_URL}/functions/v1/bulk-scan`.
- **Method:** `POST`, `multipart/form-data` with a single `image` field (the photo file).
- **Auth:** `Authorization: Bearer <supabase session.access_token>` — validated via `createClient(...).auth.getUser()` inside the function. Unauthenticated requests are rejected with 401 before the image is read.
- **Request limits:** raw file > 10MB → 413. Base64-encoded payload > ~6.7M chars (~5MB encoded) → 413 with message "Image too large — please use a photo under 4MB or split your showcase into two shots". Only `image/jpeg`, `image/png`, `image/webp` are accepted (415 otherwise).
- **Response (200):** `{ cards: [...], count: N }` — each card has a generated `id` (`crypto.randomUUID()`) plus `player, year, set, cardNumber, parallel, grade, grader, confidence, notes` (all lowercase strings per the vision prompt).
- **Error responses:** 401 unauthenticated, 413 file too large, 415 unsupported media type, 422 vision response wasn't parseable/valid JSON array (includes `rawResponse` for debugging), 502 Anthropic API error, 500 sanitized internal error (no stack traces).
- **CORS:** allows `localhost`/`127.0.0.1` (any port), `getcardshow.com`/`www.getcardshow.com`, and `*.netlify.app` (including deploy-preview subdomains); OPTIONS preflight handled.

### Fields map directly to the 7-field fingerprint schema
`player|year|set|cardNumber|parallel|grade|grader` (lowercase) — matches `price_cache` and `show_floor_transactions` exactly, so bulk-scanned cards can be cross-referenced/cached the same way single-scanned cards are.

### Secrets required (Supabase project secrets, not Netlify env vars)
- `ANTHROPIC_API_KEY` — same key family used by `vision-scan.js`, but must also be set as a **Supabase** secret (`supabase secrets set ANTHROPIC_API_KEY=...`) since this runs as an Edge Function, not a Netlify function.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — auto-injected into Edge Functions by the Supabase runtime; do not set manually.

### app.html integration (Phase 1 — scan call)
- **"📸 Bulk Scan Showcase"** button in `#sellerUploadSection`, below the CSV/XLSX drop zone. Triggers hidden `#bulkScanInput` (`accept="image/*" capture="environment"`).
- `handleBulkScanFile(input)` — reads `db.auth.getSession()` for the JWT, POSTs `FormData` to `${SUPABASE_URL}/functions/v1/bulk-scan`, shows `showToast('Scanning your showcase…')` while in flight, aborts via `AbortController` after 30s (dismissible — toasts "Scan timed out" and stops waiting). Errors show the response body's `message`/`error` in a toast. On success, calls `renderBulkScanReview(result.cards)`.

### app.html integration (Phase 2 — review/edit modal + inventory write, shipped)
- **`renderBulkScanReview(cards)`** now opens `#bulkScanReviewOverlay` (reuses the `.mapper-overlay`/`.mapper-modal`/`.mapper-header`/`.mapper-body`/`.mapper-footer` CSS system from the CSV Column Mapper modal — same "many repeatable editable rows" shape). Empty `cards` array → toast "No cards identified — try a clearer photo", no modal opens.
- Each card is rendered by `bulkScanCardBlockHTML(c, idx)` as its own bordered `.bulkscan-card-block` with: an include checkbox (checked by default, `.excluded` class dims the block at 0.45 opacity when unchecked), a confidence badge (reuses `.mapper-confidence.high/.medium/.low`), an editable Title (pre-filled via `buildCardTitle()` — note the key remap needed since the vision response uses `set`/`cardNumber` but `buildCardTitle` expects `cardSet`/`cardNum`), and editable Player/Year/Set/Card#/Parallel/Grader/Grade/Condition/Price fields matching Add Card's field set and `#ac_condition`'s exact 5-option list (Gem Mint/Near Mint/Good/Fair/Poor). Grader select prefills only on an exact case-insensitive match against PSA/BGS/CGC/SGC, else blank (Raw). The vision `notes` field (if present) renders as small muted `.bulkscan-notes` helper text — **display-only, never persisted** (`inventory` table has no `notes` column).
- Fields are edited live in the DOM (no re-render-on-keystroke, unlike the CSV mapper's single-`<select>`-per-row pattern) — `confirmBulkScanReview()` reads final values straight out of `[data-field]` attributes at confirm time, the same way `saveAddCard()` reads `#ac_x` fields. Only two scoped live updates happen during editing: `bsToggleInclude()` (checkbox → `.excluded` class + stats) and `bsToggleGraderRow()` (grader select → shows/hides that card's Condition row, mirroring `acToggle()`).
- **Title is required per included card.** `confirmBulkScanReview()` blocks entirely (inserts nothing) if any checked card has an empty title — flags every offending Title input with `.bulkscan-field-invalid` (red border, self-clears on input), scrolls the first one into view, and toasts a count. Uncheck a card instead of fixing its title to exclude it from the block.
- On a valid confirm: builds one CardShow-shaped `rawCard` per included card using the **same key mapping as `saveAddCard()`'s card branch** (`'Card Title'`, `Player`, `Year`, `'Set '`, `Number`, `'Parallel/Variant'`, `Grader`, `Grade`, `'Cert #'` (from the editable Cert # field, only when a grader is selected — see PSA verify below), `Condition`, `Price`, `Status: 'Available'`, `Location: null`, `Seller`, `item_type: 'card'`), runs each through `validateAndNormalizeCard()`, pushes to `inventory[]`, then **awaits** `bulkScanInsertMany(normalized)` (unlike `saveAddCard()`'s fire-and-forget single insert — Phase 2 deliberately waits so the success/partial-failure toast is accurate for a whole batch) before closing the modal. Confirm button shows "Adding…" while in flight.
- **Grade is sanitized, never trusted raw from vision.** `_numericGrade(g)` (app.html) returns the value only if it's a plain number (`/^\d+(\.\d+)?$/`), else empty string — vision occasionally returns a condition word like `'nm'` instead of a grade. Applied both at render time (`bulkScanCardBlockHTML`) and defensively at confirm time, since an unfiltered non-numeric grade would `parseFloat` to `NaN` and cause `validateAndNormalizeCard()` to silently strip the seller-visible Grader selection too.
- **Player/Set/Parallel render in Title Case** via `_titleCase(s)` (capitalizes after start-of-string/space/hyphen/slash) — the vision response is all-lowercase by design (see prompt). The synthesized Card Title inherits the same casing since it's built from these already-transformed values. Notes helper text gets `_capFirst()` (capitalize first letter only, since it's a full sentence).

### PSA/CGC verify button (manual, plus capped auto-verify for PSA)
- Vision prompt also extracts `certNumber` per card when visible on a graded slab's label (bulk-scan/index.ts `SYSTEM_PROMPT`).
- Each card block has an editable **Cert #** field + **"🔍 Verify with {grader}"** button, shown only when `Grader` is `PSA`, `CGC`, or `SGC` (`data-cert-row`, toggled live by `bsToggleGraderRow()` alongside the existing Condition-row toggle — `psa-lookup.js` doesn't support BGS cert lookups, so that row stays hidden for BGS/Raw).
- `bsVerifyGrader(buttonEl)` calls the **existing** `/.netlify/functions/psa-lookup` endpoint (the same one the single-card cert scanner uses) with `{ cert, grader }` — no new backend code. On success, overwrites Player/Year/Set/Card#/Parallel/Grade and re-synthesizes the Title from the authoritative response, highlighting updated fields with the existing `.db-filled` green-border convention (8s, matches `acSelect()`'s autocomplete-fill pattern). On 429, toasts a rate-limit message rather than silently retrying. Returns `{ success, status? }` so callers (manual click or auto-verify) can tell what happened.
- **`_autoVerifyPsaCards(cards)`** — fired fire-and-forget from `renderBulkScanReview()` right after the modal opens. Filters to cards where `grader === 'PSA'` (case-insensitive) and a `certNumber` is present, caps to the first `BULK_SCAN_AUTO_VERIFY_LIMIT` (5), and calls `bsVerifyGrader()` on each sequentially with a 600ms stagger — re-locating each card's button live via `[data-card-id]` rather than caching references, since the seller can edit/exclude cards while this runs in the background. Stops early and toasts if it hits a 429, leaving any remaining PSA cards (beyond the cap, or after a rate-limit stop) with their manual button untouched.
- **Only PSA auto-verifies; CGC/SGC stay manual-only**, and only within the 5-card cap per scan — a deliberate compromise between "useful without clicking" and "don't exhaust PSA's ~10 req/hr free tier in one busy showcase photo" (see Known Constraints below). Raise or lower `BULK_SCAN_AUTO_VERIFY_LIMIT` if your PSA plan's rate limit differs from the free tier.
- Only helps graded slabs (a cert number requires a slab label to exist). Does not address raw-card misidentification — see the correction pass below for that.
- **`BULK_SCAN_PSA_VERIFY_ENABLED = false`** (2026-08-21) — temporarily disables both the manual "Verify with PSA" button and `_autoVerifyPsaCards()` while the PSA API account approval is pending (403 "Access to this API is limited to approved customers" on every call). `_bsVerifySlotHTML(grader)` — shared by the initial card-block render and `bsToggleGraderRow()`'s live update — renders a plain "PSA verification paused" note instead of the button when `grader === 'PSA'` and the flag is off. CGC/SGC are unaffected (their API access isn't in question) and still get a real button. `bsVerifyGrader()` itself is untouched; flip the flag back to `true` once PSA access is resolved and both the button and auto-verify resume working with no other changes needed.

### Raw-card correction pass (catalog cross-check for player-name OCR errors)
- Targets the gap PSA verify doesn't cover: Claude vision occasionally misreads a player's name off a **raw** card (confirmed real case: "Cam Abrams" read instead of "CJ Abrams") while still reading the card number correctly. `year`+`set`+`cardNumber` usually uniquely identifies the exact card in CardSight's/PriceCharting's catalogs regardless of a misread name, so this cross-checks those three fields and corrects `player` when a confident match is found.
- **`netlify/functions/card-correction.js`** (new file) — `POST { player, year, set, cardNumber, parallel, skipCardSight? }` → `{ success, tier: 'high'|'medium'|'none', correction: { player } | null, source, cardSightRateLimited }`. Tries CardSight first (number-only catalog search — deliberately not the full 4-tier search `comp-lookup.js` uses for pricing, since the exact-number fast path is the entire premise here; a name-based CardSight retry would just search *by* the possibly-wrong name), falls back to PriceCharting per-card if CardSight has no match. `tier: 'high'` = single exact card-number match in CardSight; `'medium'` = tie-broken multiple-release match or a PriceCharting match; `'none'` = no cardNumber to search with, no match, or the "corrected" name is identical to Claude's guess (nothing to correct). Requires `cardNumber` — returns `tier: 'none'` immediately without any API calls otherwise.
- **Duplicated, not shared, logic**: `extractReleaseName`/`inferManufacturer`/`scoreCatalogMatch`-equivalent scoring (CardSight side) and `buildPCQuery`/`scorePCResult` (PriceCharting side) are copied from `comp-lookup.js` — both files' helpers are unexported file-local functions there, so there's no shared module to import from today. Name-extraction from a matched CardSight record's `name` field back to a clean player string (`extractPlayerFromCardSightName`, using `STRIP_RE`) is adapted from `trading-card-lookup.js`'s equivalent, since `comp-lookup.js` never needs to do this (it only ever returns a price, never re-parses a matched record's name). **Keep in sync if the source files' scoring/extraction logic changes** — this is intentional duplication, not a shared module, to avoid touching the larger, live-pricing-critical `comp-lookup.js` for one feature's needs.
- Tight timeouts (CardSight 4s, PriceCharting 3s) to stay under Netlify's function timeout even in the worst case (CardSight miss → PriceCharting fallback in the same invocation).
- **`_runCorrectionPass(cards)`** (app.html) — fired fire-and-forget from `renderBulkScanReview()` alongside `_autoVerifyPsaCards()`. Filters to **raw cards only** (`!grader`) with a non-empty `cardNumber`, capped at `BULK_SCAN_CORRECTION_LIMIT` (10) — unlike PSA auto-verify's rare graded slabs, this applies to most cards in a scan, so it gets a **visible progress bar + cancel button** (`_showCorrectionProgress`/`_hideCorrectionProgress`, anchored above `#bulkScanReviewBody`, same visual pattern as `runCompCheck`'s `showCompCheckProgress`/`hideCompCheckProgress` but namespaced separately) rather than running silently like PSA's rare-slab pass.
- Reads **live DOM values** per card at call time (not the original vision snapshot) since the seller may have already edited a card, or PSA auto-verify may have just populated a grader, before the correction pass reaches it — a card that gains a grader mid-pass is skipped rather than double-corrected against a less-authoritative source.
- **Per-card CardSight/PriceCharting fallback, not per-batch** — a single card's CardSight miss (404/500/network) doesn't disable CardSight for the rest of the batch, since those failures are typically card-specific (e.g. an alphanumeric card-number format CardSight's search chokes on), unlike PSA's rate-limit failures which are reliably batch-wide. The one exception: a CardSight 401/429 sets `cardSightRateLimited: true` in the response, which the client remembers via `skipCardSight` for the rest of that scan's remaining correction-pass calls (skips straight to PriceCharting), matching PSA's stop-on-429 reasoning but scoped to just that one source rather than the whole feature.
- **High-confidence corrections auto-apply silently** (green `.db-filled` highlight only, matching `bsVerifyGrader`'s convention — no note needed since the highlight itself signals a change). **Medium-confidence corrections also auto-apply**, but additionally get a `.bulkscan-notes` line ("Player name corrected from a catalog match — please verify before saving"), overwriting any note Claude's vision originally supplied for that card. This was a deliberate choice to keep the interaction model consistent with PSA verify (always overwrites, no confirm step) rather than building new suggest-and-click UI — revisit if sellers report bad medium-tier corrections in practice.
- Cap of 10/scan is a budget guard against CardSight's 750 calls/month free tier, since (unlike the rare PSA slab) most raw cards in a scan are eligible — raise/lower `BULK_SCAN_CORRECTION_LIMIT` based on actual usage. Cards beyond the cap keep Claude's original guess with no automatic fallback in v1 — there is no manual per-card "re-check" button yet (unlike PSA verify's manual button), since this wasn't asked for; would be a natural follow-up if the cap proves too limiting in practice.
- **`CARDSIGHT_API_KEY` and `PRICECHARTING_TOKEN` are shared with comp-pricing** (`comp-lookup.js`) — no separate enable flag or budget split between comp-check's CardSight usage and correction-pass's. Both draw from the same monthly CardSight quota.
- **`bulkScanInsertMany(cards)`** (app.html, next to `insertCardToDB`) does ONE seller-UUID lookup, then `Promise.all`s N inserts via `insertCardToDB(card, sellerId)` — `insertCardToDB` gained an optional second `sellerIdOverride` param (backward-compatible; its one pre-existing call site in `saveAddCard()` still omits it and does its own per-call lookup). Avoids N redundant `sellers` table round-trips for one scan batch.
- Toast on completion: `"N card(s) added to inventory"` on full success; `"N of M cards synced — K saved locally only"` in gold if any DB insert returned `null` (mirrors the pattern of surfacing partial failure rather than the single-card flow's silent `console.warn`-only swallow — a partial failure across a batch is both more likely and worse to hide).
- `CardShow_BulkScan_POC.html` referenced in earlier planning was never actually committed to this repo — Phase 2 was designed fresh from Add Card / CSV Mapper / vision-confidence conventions instead.

### Source photo reference (review modal)
- `_bulkScanSourceImage` (app.html) — the uploaded photo's data URL, captured client-side via `_readFileAsDataURL()` in parallel with the upload request (near-instant, local, doesn't block the scan). Rendered as an 88×88 clickable thumbnail pinned in `#bulkScanSourceImageWrap` inside the review modal's header (`.mapper-header`, not the scrollable `.mapper-body`) so it stays visible while scrolling through card entries. Click opens `#bulkScanImageLightbox` (reuses the generic `.modal-overlay` system) full-size; Escape/click-outside closes it, and the global Escape handler checks the lightbox before the review modal so the two don't both close on one keypress.
- Released (`_bulkScanSourceImage = null` + wrapper cleared) in `closeBulkScanReview()` — a photo's data URL can be several MB, no reason to hold it after the modal closes.
- **This shows the whole original photo, not per-card cropped thumbnails.** Per-card crops would need Claude to return a bounding box per identified card, then client-side Canvas cropping — deferred because Claude isn't a dedicated object-detection model and box precision on a busy/overlapping showcase photo is a real accuracy risk, not just more work. Revisit if the whole-photo reference proves insufficient in practice.

### Analysis loading overlay
- **`#bulkScanLoadingOverlay`** (reuses the generic `.modal-overlay`/`.modal` system, `max-width:340px`) — replaces the old toast+button-label approach as the primary "this is working" signal. That old approach had a real gap: the toast auto-faded after 3s and the button-label fallback lived on `#bulkScanBtn`, which is inside the sidebar — invisible whenever the sidebar is collapsed (default on mobile) or the seller triggered the scan from the Add Card modal's shortcut link (which closes before the button would even be visible). A full-screen overlay has neither problem.
- `_showBulkScanLoading()` / `_hideBulkScanLoading()` — opens/closes the overlay and manages `BULK_SCAN_STATUS_MESSAGES` rotation (`_bulkScanStatusInterval`, one message every 6s, holds on the last message if the scan runs long). `handleBulkScanFile()` still disables `#bulkScanBtn` too, but that's now just a cheap secondary guard against a second tap — the overlay itself already blocks interaction with the rest of the page.
- **Cancel is wired through the existing `AbortController`**, not a separate mechanism — `_bulkScanAbortController` is the same controller `handleBulkScanFile()` already used for the 60s timeout. `_cancelBulkScanLoading()` (Cancel button, Escape, or click-outside) calls `.abort('cancelled')`; the 60s timeout calls `.abort('timeout')`; `handleBulkScanFile()`'s catch block reads `controller.signal.reason` to show the right toast ("Scan cancelled" vs "Scan timed out") instead of a separate boolean flag.
- Escape-key priority: lightbox → loading overlay → review modal (checked in that order in the shared keydown handler) so only the topmost one closes per keypress, matching the lightbox-over-review-modal precedent already established.

### Testing
```bash
# Local (after `supabase start` / `supabase functions serve bulk-scan --env-file .env.local`
# with ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY set):
curl -i --location --request POST 'http://localhost:54321/functions/v1/bulk-scan' \
  --header "Authorization: Bearer $SUPABASE_USER_JWT" \
  --form 'image=@/path/to/showcase.jpg;type=image/jpeg'

# Deploy to production:
supabase functions deploy bulk-scan --project-ref qtnqawqlmttogwnjieky

# Set the required secret once (per project, not per deploy):
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref qtnqawqlmttogwnjieky
```
No new Netlify env vars are needed — this function is deployed and configured entirely through the Supabase CLI/dashboard, separate from the `netlify/functions/*` deploy path.

## Trading Card API Integration

`TRADING_CARD_API_KEY` went live partway through this build (previously pending early-access approval — see `trading-card-lookup.js`'s original routing comment). Building against the real, now-working key surfaced two things worth knowing before touching this area again:

1. **`filter[x]=` query params are effectively non-functional on this API today**, on both `/v1/cards` and `/v1/sets`, for both attribute filters (`filter[name]`) and relationship filters (`filter[player_id]`) — every one silently falls back to the full unfiltered collection instead of erroring. This is a *live production bug*, not just a concern for new code: `trading-card-lookup.js`'s `filter[name]` search (used by the old `#ac_search` box, now removed) was verified broken the same way, returning essentially random catalog entries for real player searches. It went unnoticed because the key wasn't live until this session.
2. **`filter[player_id]` on `/v1/cards` is real and correctly documented** in the API's own OpenAPI spec (`https://tradingcardapi.com/openapi.json`) — "Returns every card the player appears on, both directly and via a player-team" — but it does not return within Netlify's ~10s synchronous function ceiling, tested repeatedly (6s and 9s proxy timeouts, both exhausted; the player resource itself also has no `relationships` block in its schema to side-load as a faster alternative). **There is no fast player → cards/sets path on this API.** Any future feature that wants "cards/sets for a given player" needs to route around this the same way both features below do.
3. **The plain (non-bracketed) `full_name=` and `name=` params are real and do filter — but not as a live-typing prefix search, and the asymmetry matters.** `GET /v1/players?full_name=` prefix-matches a *first-name* token on its own (`full_name=paul` → 583 matches, genuinely a prefix search) — but a *last-name* token never prefix-matches, at any length short of complete: `full_name=skene` (one letter short of "skenes") returns zero, identically to `full_name=sk`. Only the exact, complete last name works (`full_name=paul skenes` → 1; `full_name=paul ske` → 0). This means there is no query shape that can narrow toward a specific player while their last name is still being typed — falling back to a broader single-word query (e.g. `full_name=paul` alone) just substitutes an unrelated, unranked candidate list with nothing to tell it apart from a real match, which is worse than showing nothing. `GET /v1/sets?name=` is stricter still — it requires the *entire* value to exactly match a set's name; even a single complete word alone (`name=Bowman`) returns zero against a real set like "2025 Bowman Chrome". None of this is documented in the OpenAPI spec, and none of it was found by reasoning about encoding/URL correctness in the abstract — an initial fix targeted a real but unrelated double-encoding issue, shipped without re-testing the original failure, and only reproducing that exact failure against the live deploy afterward surfaced the actual (word-not-prefix matching) cause.

Confirmed-real endpoints (verified directly against `https://tradingcardapi.com/openapi.json` and, separately, against live production behavior):
- `GET /v1/players?full_name=` — prefix-matches a single word; requires a complete token for any word after the first
- `GET /v1/sets?name=` — exact full-string match only, no partial matching at any granularity
- `GET /v1/sets?parent_id=` — plain param, returns child/parallel sets of a given set, fast
- `GET /v1/sets/{id}/checklist?format=compact&include=checklist&per_page=N` — fast; returns the **set** as primary `data` with cards as bare `{type,id}` refs, `include=checklist` puts the real `number`/`name` attributes into `included`. (`v2` of this endpoint documents the same `format=compact` param but silently ignores it — confirmed by the API team as a `v2`-specific bug, `v1` is correct. Switched off `v2` once this was confirmed.)
- `GET /v1/cards?filter[set_id]=` — documented but not exercised by either feature below (checklist covers the same need)

**Don't pre-encode query values before handing them to `tcapiGet(path)`.** `tcapiGet()` already wraps its entire `path` argument in one `encodeURIComponent()` call so it survives being embedded as this app's own `?path=` query param. Calling `encodeURIComponent()` on a value *before* interpolating it into that path double-encodes it (`"paul sk"` → `"paul%20sk"` → `"paul%2520sk"`) — Netlify's one automatic decode of the outer wrapper only undoes the outer layer, leaving a literal `%20` in the value actually sent to Trading Card API, which matches nothing. Build the path with raw values interpolated directly; let `tcapiGet()`'s own encoding be the only pass.

### API team response to the issue list above (2026-08-22)

We filed the 9 issues above with Trading Card API's team. Their response, each point re-verified live rather than taken on trust (the double-encoding red herring earlier in this project is exactly the failure mode that habit avoids):

- **`filter[x]=` non-functional → fixed, confirmed.** Now returns `400`/`422` for a bad param instead of the unfiltered collection. The convention differs per resource and isn't uniform: `/v1/cards` keeps bracketed `filter[player_id]`/`filter[set_id]`; `/v1/players` and `/v1/sets` use bare params (`full_name=`, `name=`, etc.) — matches what this codebase already does everywhere.
- **`filter[player_id]` on `/v1/cards` timing out → fixed, confirmed.** Re-tested against the exact same player UUID used throughout this file: 912 results in ~1.1s (previously never completed at any timeout tried, up to 10s+). Each card includes its `set_id` directly. **This reopens a design option that wasn't available when Steps 2/4 and the bulk-scan validator were built** — see "Open question" below. `include=` from `/v1/cards` is still not viable (confirmed `include=set` → `422 INVALID-INCLUDE-IN-URI`); the player→cards→set_id round trip is the only path.
- **Last-name prefix matching → still broken, confirmed.** `full_name=paul+ske` and `last_name=like:sken` (their own suggested `like:` prefix operator) both still return 0. No client-side fix is possible; the `stillTyping` messaging in Step 1 remains correct and necessary.
- **`/v1/sets?name=` has a real `like:` prefix operator → confirmed, was undocumented at the time.** `name=like:Bowman Chrome` → 27 results (`name=Bowman` alone still → 0, so it's specifically a `like:` prefix, not a general substring match). Doesn't change anything here: `_tcGetAllSets()`'s fetch-all-273-and-cache-client-side approach is still preferable for a live-typing dropdown (zero network round-trips per keystroke after the first fetch) — this operator matters more for the "one-shot lookup" cases (the bulk-scan validator, see below) than for interactive search.
- **273 sets vs 1.77M cards isn't sparseness, it's a data leak.** `/v1/sets` correctly returns only the 273 *published* sets; `/v1/cards` (and by extension `filter[player_id]` results) includes cards whose `set_id` points at *unpublished* sets that 404 if looked up directly. Doesn't affect this codebase either way — nothing here ever calls unfiltered `/v1/cards`, only `/v2`→`/v1` checklist calls scoped to an already-published set ID pulled from `_tcGetAllSets()`. 2024 Bowman Chrome is still genuinely unpublished, though — that part wasn't the leak.
- **Parallel/subset sparsity (100/273 sets) → confirmed, prioritization matches**, no timeline. No code change — the year-required + parallel-cross-check logic in the bulk-scan validator remains necessary until this is backfilled.
- **`product_line`/`brand_family` modeling gap (Upper Deck vs. Upper Deck Black Diamond) → confirmed real, no fix yet.** No code change — the parallel-cross-check veto in the bulk-scan validator remains the mitigation until (if) they ship a real brand hierarchy.
- **`format=compact` on the checklist endpoint → `v2` confirmed buggy (silently ignores the param), `v1` confirmed correct.** Switched both checklist call sites (Add Card picker Step 3, bulk-scan validator) from `v2` to `v1` — see the endpoint list and Step 3 above. Not a drop-in URL swap: `v1`'s response shape is fundamentally different (set as primary `data`, cards as bare refs) and needs `include=checklist` to get `number`/`name` into `included` at all — confirmed the exact shape live before switching, since "v1 matches the docs" didn't by itself guarantee it would return what this code actually consumes.
- **`/v1/` prefix inconsistency on relationship links → confirmed, filed on their side.** No code change — nothing here constructs URLs from `relationships.*.links`.

**Open question, not yet acted on:** with `filter[player_id]` now fast, Step 2 (currently a manual set search, not auto-scoped to the player — see above) and the bulk-scan validator's set-matching (currently a substring+year+parallel-veto heuristic against the cached catalog) could both be rebuilt to derive a player's actual sets from their real card data instead of guessing by name. For the validator specifically this would remove the *root cause* of the "wrong sibling product" bug class (the Upper Deck/Black Diamond case), not just the mitigation — but it's a real rework (pagination for a heavily-printed player's cards, e.g. 912 total for the one tested here, isn't a single call), not a small patch. Flagged for a deliberate decision rather than done opportunistically alongside this response.

### Architecture
All calls are proxied through `netlify/functions/tcapi.js` — a generic `GET ?path=/v1/whatever` passthrough that adds `Authorization: Bearer TRADING_CARD_API_KEY` server-side. 9s internal timeout (`AbortController`), just under Netlify's ~10s synchronous function ceiling (matches `vision-scan.js`'s 10s convention) so our own clean timeout response wins the race against the platform killing the function outright.

Client-side helper: `tcapiGet(path)` (app.html, top of the main `<script>` block, alongside `STATE`) — takes a full API path+querystring, proxies through `tcapi.js`, returns parsed JSON or `null` on any non-2xx/network error.

This is unrelated to `netlify/functions/trading-card-lookup.js`, which still exists and still owns its own key handling, `card_search_cache` table, and CardSight/PriceCharting/Pokémon TCG fallback chain for **comp pricing** (`comp-lookup.js` is the actual comp-check consumer, not this). `trading-card-lookup.js`'s free-text search *consumer* — the old `#ac_search` box — is what got replaced below; the function itself was left alone.

### Add Card Modal — Guided Picker (replaces #ac_search)
The old free-text "Search Card" box, its dropdown, spinner, debug note, and the ~120-entry local `CARD_DB` stub it fell back to have all been removed. In their place, the Player/Set/Card #/Parallel fields themselves now carry a 4-step guided picker:

- **Step 1 — Player typeahead** (`#ac_player`, `tcPlayerTypeahead()`): 3+ chars, 400ms debounce, `_tcSearchPlayers(q)` → `GET /v1/players?full_name={q}`. First-name-only queries prefix-match reliably (`full_name=paul` → 583 results) so those search live as expected. A multi-word query that matches nothing is reported back as `stillTyping: true` rather than silently retried against a broader single-word query — an earlier version of this fell back to `full_name={firstWord}` alone, but that fallback returns an *unrelated* candidate list (e.g. other players named "Paul") with nothing distinguishing them from real matches, which is actively misleading rather than helpful. Confirmed why no fallback can work here: last-name tokens never prefix-match at any length short of complete — `full_name=skene` (one letter short of "skenes") still returns zero, identically to `full_name=sk`. So once `stillTyping` is true, the dropdown shows a plain "finish the last name to match" message instead of a candidate list. `_tcSearchPlayers()` is shared with the bulk-scan validator below (which ignores `stillTyping` — it validates an already-complete vision-extracted name, not live-typed input). Selecting a result fills Player + `acPlayerUUID`, clears all downstream UUIDs, and focuses the Set field.
- **Step 2 — Manual set search** (`#ac_set`, `tcSetSearch()`): **not auto-scoped to the selected player** — see the API constraint above. `GET /v1/sets?name=` requires an exact full match with no partial matching at all, so it's unusable for a live-typing dropdown. Instead, `_tcGetAllSets()` fetches the *entire* set catalog once per session (273 sets total, confirmed live — small enough to cache in full; paginated fetch, deduped via an in-flight promise so concurrent callers share one fetch) and every keystroke filters that cached array client-side by substring — the same approach Step 3 already used for its checklist. Shared with the bulk-scan validator below. Selecting a result fills Set (lowercase) + `acSetUUID`, clears Card#/Parallel + their UUIDs, and fires Step 3 automatically.
- **Step 3 — Checklist/card picker** (`#ac_number`, auto-fires after Step 2): `GET /v1/sets/{id}/checklist?format=compact&include=checklist&per_page=100` (cards read from `included`, not `data` — see the endpoint note above), filtered client-side to entries whose `name` contains the selected player (falls back to the full checklist if nothing matches or no player is set yet — still useful for picking a card number). Selecting a result fills Card # + `acCardUUID`, fires Step 4.
- **Step 4 — Parallel picker** (`#ac_parallel`, auto-fires after Step 3): `GET /v1/sets?parent_id={setId}&per_page=100`. This mechanism itself is confirmed correct and working (verified with a real example — 2018 Panini Contenders Draft Picks returns 12 real parallels: "College Ticket Autographs," "Old School Colors," etc.) — but the catalog's parallel/subset data is incomplete: only 100 of 273 sets have any `subset_count > 0` (confirmed by checking every set's own record). Recent releases are more likely to be gaps — 2025 Bowman Chrome, for instance, has `subset_count: 0` despite obviously having real parallels in the physical product. An empty Step 4 dropdown is very often this content gap, not a picker bug — don't "fix" this path without first confirming the target set actually has parallel data in the catalog. Selecting a result fills Parallel (lowercase) + `acParallelSetUUID`.

Every step is fully skippable — typing directly into any of the four fields works unmodified (`saveAddCard()` already read raw `.value` regardless of picker state, so no changes were needed there), each populated dropdown ends with an "Enter manually" link that just clears that dropdown's container, and empty results show "No matches — enter manually" instead of blocking. Manually editing a field after a selection clears that field's hidden UUID (`oninput` on each of the four inputs) so a stale UUID never lingers attached to now-different text.

Hidden fields `acPlayerUUID` / `acSetUUID` / `acCardUUID` / `acParallelSetUUID` store the picked UUIDs for future use (fingerprint validation, image lookup) — not persisted to Supabase this sprint. Cleared in both `openAddCard()` (via `tcClearPickerState()`) and `closeAddCard()`.

`.tc-dropdown` / `.tc-dropdown-item` / `.tc-item-sub` / `.tc-loading` / `.tc-dropdown-skip` (styles block) use the app's actual live `:root` CSS variables (`--card`, `--border`, `--text`, `--muted`, `--accent`) rather than the hex literals in the original design spec — those hex values matched this file's own "Brand System" doc section above, not what's actually declared in `:root` (e.g. live `--muted` is `#6b7280`, not the documented `#5A6585`). Using the real variables keeps the picker visually consistent with the rest of the modal; the doc/`:root` mismatch itself is pre-existing and out of scope here.

`scanFallbackToSearch()` (cert scanner's "Search by name" fallback) now focuses `#ac_player` instead of the removed `#ac_search`.

### Bulk Scan Validation Layer
`renderBulkScanReview(cards)` already rendered a full review grid before this change (confidence badges, source-photo thumbnail, PSA verify, raw-card correction pass, etc.) — it was never the stub the original task spec described, and `CardShow_BulkScan_POC.html` still doesn't exist in this repo (see the note earlier in this file). This feature adds a validation pass *on top of* the existing grid, not a replacement.

`_runTcapiValidation(cards)` fires fire-and-forget from `renderBulkScanReview()`, alongside the existing `_autoVerifyPsaCards()` and `_runCorrectionPass()` calls. For every card with `confidence !== 'low'`, `_tcapiValidateOneCard()` runs via `Promise.allSettled` (never blocks the already-rendered grid):
1. `_tcSearchPlayers()` (shared with the Add Card picker, see above) on the live Player field value — a match sets the VERIFIED badge and is the *only* condition for `tcapi_validated`-equivalent status, matching the spec's "tied to player match" rule. No match → UNVERIFIED, nothing further attempted.
2. Best-effort enrichment once a player matches (adapted from the spec's broken `filter[player_id]` approach): `_tcGetAllSets()` (same session-cached full catalog as the picker's Step 2 — `GET /v1/sets?name=` is exact-match-only and unusable here, a vision-extracted set name is very unlikely to match it character-for-character) filtered client-side by substring, **requiring the card's year to also match** — a bare set name like "Bowman Chrome" substring-matches base sets, exhibits, university/draft spin-offs, and convention one-offs across many years with no way to tell which is right, so without a year the enrichment is skipped entirely rather than guessed (a real failure caught this: a card with a blank Year got "verified" into "2019 Topps NSCC Bowman Chrome National Convention," which only won because the catalog sorts alphabetically and that name happens to sort first). When several sets share the year and substring, the shortest matching name wins as a tiebreaker — the base/mainline product name is always a prefix of longer exhibit/variant names, never the reverse. This doesn't cover every case, though: a year+substring match can still land on the *only* candidate and still be wrong, when two sibling products happen to share a brand name in their catalog strings (a real failure: "Upper Deck" + "2022" + parallel "Young Guns" matched the only candidate, "2022-23 Upper Deck Black Diamond /349" — a different physical product from the plain Upper Deck set Young Guns actually belongs to, that just happens to also contain "Upper Deck" in its name). So before trusting a match, `GET /v1/sets?parent_id={id}` is fetched first — when the matched set has real catalogued subsets, the card's stated Parallel has to plausibly be one of them or the match is discarded entirely (confirmed: Black Diamond has 40 real subsets, "Young Guns" isn't among them). A set with no subset data at all (e.g. 2025 Bowman Chrome) still gets the benefit of the doubt — nothing to cross-check against there. Once a match survives this check, it also feeds `GET /v1/sets/{id}/checklist?format=compact&include=checklist` (fills Card # if empty, matched by player-name substring) and reuses the same parallels response to normalize the Parallel field. Any failure here is silent/non-fatal and never downgrades an already-VERIFIED badge.
3. Field updates reuse the existing `.db-filled` green-highlight convention (`bsVerifyGrader`, `_applyCorrectionToBlock`) via `_bsApplyValidatedField()`.

Badge states (`.tc-verify-badge`, injected into `.bulkscan-card-header` next to the confidence badge): `VERIFYING` (spinner, muted) while in flight → `✓ VERIFIED` (`#1BAF7A`) or `UNVERIFIED` (muted) on resolution. Low-confidence cards are skipped entirely — no badge element is ever created for them, satisfying "show nothing" for free.

Fingerprint preview: `data-fingerprint` elements are **debug-only** (`window.CARDSHOW_DEBUG`), not shown to sellers — a raw pipe-delimited fingerprint string has no seller-facing value and 10-15 of them per scan would just be clutter. `_bulkScanFingerprintFromBlock()` reads live DOM values (matching the correction pass's own "read live DOM, not the original vision snapshot" convention) rather than tracking canonical values separately on the card object — since validated fields are written straight into the same `[data-field]` inputs `confirmBulkScanReview()` already reads at save time, canonical values flow through to the saved fingerprint automatically with no extra plumbing. Updated once on initial render (debug mode only) and again whenever validation resolves for that card.

## DB Migration: show_events (run in Supabase SQL editor)
```sql
-- show_events: lightweight event log for buyer searches and QR scans
-- Append-only. Admin-readable. No RLS enforcement (permissive like other tables).
CREATE TABLE IF NOT EXISTS show_events (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  show_id     text NOT NULL,
  event_type  text NOT NULL,  -- 'buyer_search' | 'qr_scan'
  event_data  jsonb,          -- { query: string } for searches; {} for scans
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS show_events_show_id_idx
  ON show_events (show_id);
CREATE INDEX IF NOT EXISTS show_events_type_idx
  ON show_events (show_id, event_type);
```
Must be run before the organizer analytics dashboard's search/QR metrics will populate — see below. The dashboard degrades gracefully (shows '—') if this table doesn't exist yet.

## DB Migration: show_floor_transactions.source (run in Supabase SQL editor)
```sql
-- Adds provenance tracking to the immutable transaction table.
-- DEFAULT 'platform' correctly labels all existing rows and all
-- future recordShowTransaction() calls without any code change.
-- This is ADD COLUMN only — the immutability contract is preserved.

ALTER TABLE show_floor_transactions
  ADD COLUMN IF NOT EXISTS source text
    NOT NULL DEFAULT 'platform'
    CHECK (source IN (
      'platform',           -- CardShow sell drawer / Scan-to-Sell POS
      'manual',              -- seller self-reported off-platform sale
      'community_report',   -- web reporting form (future)
      'social_extract'      -- public social post extraction (future)
    ));
```
Must be run before "Log a Manual Sale" (see below) can write a `source:'manual'` row — without it, `recordManualSaleTransaction()`'s insert fails on the missing column and only warns to console (non-fatal, matches every other `show_floor_transactions` write in this app).

## Show Organizer Analytics Dashboard

### Entry point
📊 Analytics button on each admin show card → `openShowAnalytics(showId)`.
Replaces the `#adminShowsDashboard` view with `#showAnalyticsPanel`.
Back button calls `closeShowAnalytics()`, which restores `adminShowsDashboard`.
`switchAdminTab()` also force-hides `#showAnalyticsPanel` on every tab switch so it can't be left showing behind the Shows/Inventory/Report tabs.

### Data sources
- `show_inventory` → `inventory` — fetched as **two explicit queries** (all `card_id`s for the show, then `inventory.in('id', cardIds)`), not a nested FK-embed `select()`. This codebase already documented a case (`loadShowSellersAndTables()`) where PostgREST's embedded-join syntax silently returned null on a stale schema cache — the two-step form is the established, proven-reliable pattern here and is used for the same reason.
  - Fields read: `status, sold_price, payment_method, seller_id, player, year, card_set, parallel, grade, grader, price, card_title, item_type`
- `show_events` table — `buyer_search` and `qr_scan` event log
  - `event_type`: `'buyer_search'` | `'qr_scan'`
  - `event_data`: `{ query: string }` for searches; `{}` for scans
- `shows{}` in-memory cache — authorized sellers (`Set`), tables, dates
- `sellers` table (async enrichment) — `handle` and `display_name` for seller UUID → display label, resolved after the seller table renders so it never blocks the initial paint
- `show_sellers` table — `seller_id → table_number` mapping, queried directly (not via `shows{}.tables`, which is keyed by handle, not UUID) so it lines up with `inventory.seller_id` with no extra handle round trip

### Event instrumentation
- `_logShowEvent(type, data)` (top of script, next to `tcapiGet`) — fire-and-forget append to `show_events`; no-ops when there's no active/buyer show or `db` is unavailable.
- Triggered in `filterBuyer()`, after `renderBuyerGrid(results)`, for non-trivial searches (3+ chars). **No debounce** — fires on every qualifying keystroke via the existing `oninput` wiring. Worth adding a 1–2s debounce if search volume at a live show turns out to be a real cost (see Limitations).
- Triggered in `joinShow(showId)`, right after `activeShowId = showId` is set, once per show join/QR scan.

### Key functions
- `openShowAnalytics(showId)` / `closeShowAnalytics()` / `reloadShowAnalytics()`
- `_orgFetchAndRender(showId)` — async; fetches inventory + events + table assignments in parallel via `Promise.all`
- `_orgFetchInventory(showId)` — two-step `show_inventory` → `inventory` query (see above)
- `_orgFetchEvents(showId)` — `show_events` log; degrades gracefully (returns `[]`) if the table is missing
- `_orgFetchTableAssignments(showId)` — `show_sellers.select('seller_id, table_number')`; returns `{ tableMap: { seller_id: table_number }, sellerIds: [seller_id, ...] }`. `sellerIds` is the full authorized roster for the show — every authorized seller gets a `show_sellers` row on authorization (`addShowSellerToDB`) whether or not a table is assigned yet, so this is not limited to sellers with a table. Degrades to `{ tableMap: {}, sellerIds: [] }` on error.
- `_orgRender(showId, cards, events, tableMap, authorizedSellerIds)` — computes all metrics, calls sub-renderers. `authSellers` (used by the Active Sellers KPI and Participation bar) prefers `authorizedSellerIds.length` — the same live count that seeds the seller table below — falling back to the handle-keyed `shows{}.sellers` Set only if that fetch failed, so the KPI and the table never disagree.
- Also stamps a fresh `showCardCounts[showId]` from the live `cards.length` and calls `updateAscHeader(showId)` — the Shows dashboard's "Cards" stat chip is otherwise only refreshed once, at admin login (`refreshShowCardCounts()`), and goes stale the moment inventory is published afterward.
- `_orgSetKPI(id, value, sub)` — updates one north-star KPI card's value + sub-label
- `_orgRenderSellerTable(sold, allCards, authorizedSellerIds)` — revenue-by-seller table, one row per **authorized** seller, not just sellers with published inventory. `authorizedSellerIds` seeds a $0 row for every seller before `sold`/`allCards` are folded in — without this seed, a seller who hasn't published anything to the show has zero matching card rows and silently never gets a table entry at all (this was a real bug: a show with 19 authorized sellers only showed the 7 who'd actually published inventory). No row cap — this is the full roster, not a top-N leaderboard. Renders with truncated-UUID placeholders immediately, then `_orgEnrichSellerHandles()` swaps in real handles/display names asynchronously.
- `_orgEnrichSellerHandles(sellerIds)` — async UUID→handle/display_name lookup from `sellers` table, targets rows via a per-seller CSS class (`org-seller-handle-{uuid8}`)
- `_orgRenderTablePerformance(sold, allCards, tableMap)` — revenue-by-table table, one row per **table with a seller assigned**, not just tables whose seller has published inventory. `tableMap` (every `seller_id → table_number` pair) seeds a $0 row for each assigned table before `sold`/`allCards` are folded in — same fix and same underlying bug class as the seller table (a table whose only seller(s) haven't published anything yet had zero matching card rows and never appeared at all). Ranked by revenue descending; ties (mostly $0 tables now) break by table number ascending rather than arbitrary insertion order. Groups sold + listed cards by table number (via each card's `seller_id → tableMap`), not by seller, so co-sellers sharing one table roll into a single row. Columns: Table, Revenue, Sold, Sell-Thru, Sellers (count at that table — included so a table's high GMV can be told apart from "it just has more sellers on it" before an organizer raises its price), Avg $. Cards whose seller has no `table_number` row roll into a "No table" bucket rather than being silently dropped.
- `_orgRenderTopCards(sold)` — top 10 by `sold_price`
- `_orgRenderParticipation(uploaded, authorized)` — sellers who uploaded ≥1 card ÷ authorized sellers
- `_orgRenderSearchAnalytics(searches, cards)` — top queries + zero-result detection against this show's listed player names
- `_orgRenderPaymentBars(sold)` — payment method breakdown, bar width relative to the largest method's total
- `_orgRenderVsPrev(showId, gmv, sold, stPct)` — async; finds the most recent show before this one by date, fetches its inventory, renders GMV/transactions/sell-through delta badges

### Zero-result search detection
A query counts as "found" if it's a substring of a listed player's full name, **or** a non-empty word of that player's name is a substring of the query — an empty/missing name segment is never treated as a match. (An earlier draft of this logic fell back to `''` for players with a one-word name, and `string.includes('')` is always `true` in JS — that would have silently marked every search as "found" once any single-name player was in inventory. Fixed before shipping.) This remains a fuzzy, client-side heuristic, not exact search-result tracking — see Limitations.

### Limitations / future improvements
- Zero-result search detection is fuzzy client-side name matching, not real search-result tracking. A server-side approach that logs actual result counts would be more accurate.
- Seller handle enrichment fires a fresh `sellers` query every time analytics is opened. Could be cached across opens in one session.
- `filterBuyer()` logs every qualifying search input change with no debounce — fine at low volume, worth revisiting if a busy show generates excessive `show_events` writes.
- Buyer search events are only logged when the buyer is in `app.html` (not from `show.html` or `seller-browse.html`). Extend `_logShowEvent()` to those pages for full search coverage.
- `show_events` has no RLS policy tightening — matches the rest of the schema's current permissive-by-default posture (see RLS note above); revisit together.

## Auto-Publish on Insert

Cards added mid-show (Add Card, Scan-to-Sell POS, bulk scan review, CSV/XLSX import) previously had no `show_inventory` row until the organizer re-ran **Publish Inventory** — invisible to buyer search and to the analytics dashboard (`_orgFetchInventory()` only sees cards with a `show_inventory` row) until then. Every insert path now auto-publishes to the seller's `activeShowId` immediately, fire-and-forget.

### Helper
`_autoPublishCardToShow(card, dbId, showId)` (app.html, immediately before `insertCardToDB`) — fire-and-forget, never awaited by any caller. Upserts `{ show_id, card_id }` to `show_inventory` with `onConflict: 'show_id,card_id'` (same unique constraint `publishShowInventoryToDB()` already relies on — duplicate-safe). On success: adds `showId` to `card._shows`, increments `showCardCounts[showId]`, calls `syncBuyerView()`. On failure: `console.warn` only, never surfaced to the seller — a card that fails to auto-publish is still safely in `inventory[]`/DB and gets picked up by the next full `publishShowInventoryToDB()` run.

### Four insert paths wired
1. `saveAddCard()` — fires inside the existing `insertCardToDB(card).then()` callback, guarded on `activeShowId`. Toast changes from `"✓ … added to inventory"` to `"✓ … added · going live on show floor…"` when a show is active, so the seller knows publishing is happening without waiting on it.
2. `posInsertAndOpenDrawer()` — fires right after `insertCardToDB`/timeout race resolves with a real `dbId`, before `openSellDrawer()` opens. Chain: `insertCardToDB()` (inventory row) → `_autoPublishCardToShow()` (show_inventory row, fire-and-forget) → `openSellDrawer()` → `sdConfirm()` → `updateCardInDB()` (sold_price) + `recordShowTransaction()` (unchanged) — so a POS sale is fully visible in Analytics (GMV, seller revenue, top cards) with no organizer action required.
3. Bulk scan review confirm block — after `bulkScanInsertMany(normalized)` resolves, iterates `dbIds[]` (same order as `normalized[]`) and fires once per successfully-inserted card.
4. `upsertCardsToDB()` (CSV/XLSX import) — **implementation differs from the original spec.** The batch insert now does `.insert(toInsert).select('id')` and captures the returned IDs directly, matched back to their source card objects via a parallel `toInsertCards` array built alongside `toInsert` during the same `cards.forEach` pass. The original spec's approach — re-querying `inventory` for the seller's `N` most-recently-created rows (`order('created_at', ascending:false).limit(toInsert.length)`) — would race against any concurrent insert from another tab/session and had no way to guarantee the "N most recent" rows were actually the ones just inserted. `.select('id')` on the insert itself returns exactly the rows this call created, in input order, with no guessing. This also fixes a latent gap where CSV-imported cards never got `card._dbId` set at all (unrelated existing cards going through the `toUpdate` path already had it from the original fetch) — harmless side effect, sets it only when not already present. Only `toInsert` cards are auto-published; `toUpdate` cards are skipped since they already have a `show_inventory` row from a prior publish run.

### Not touched
`_orgFetchInventory()`, `_orgRender()`, and every other analytics function · `recordShowTransaction()` · `sdConfirm()` · `openSellDrawer()` · `publishShowInventoryToDB()` (still the canonical initial-publish and reconciliation tool — auto-publish supplements it, doesn't replace it) · `_logShowEvent()` · `filterBuyer()` · `joinShow()` · RLS policies · no new DB tables or migrations.

### POS timeout edge case
If `insertCardToDB()` times out inside `posInsertAndOpenDrawer()`'s `Promise.race` (`POS_INSERT_TIMEOUT_MS` = 8000ms), `dbId` is `null`, auto-publish is skipped (no `show_inventory` row), and the card won't appear via `_orgFetchInventory()`. It's still recorded in `show_floor_transactions` via `recordShowTransaction()`, which reads the in-memory card object directly and doesn't depend on `_dbId` — so the sale itself isn't lost, just temporarily absent from the show-scoped Analytics view until the organizer republishes. Same graceful-degradation shape as every other `dbId === null` path in this app.

## Backlog Priority

### Shipped ✅
- Supabase inventory persistence (read, write, edit, mark sold, CSV import)
- Seller profile persistence (display name, WhatsApp, Instagram)
- Shows persistence layer (create, edit, delete, sellers, table numbers, publish)
- Phase 2 email authentication (Supabase Auth)
- Demo inventory gated to buyer flow only — sellers/admins start with empty inventory
- Seller empty-state CTA ("Your inventory is empty" + Add Card / Upload CSV buttons)
- switchView() async-safe fix — resolves blank seller screen on login
- Partnership link / Profile button visibility fix
- Login page always shown on fresh navigation (session restore removed)
- Sell drawer, sold price + payment tracking, report tab, delete card (single + bulk)
- Stat strip redesign: Available / Ask Value / Graded / Sold / Revenue (two-state)
- Seller signup fix — sellers row inserted before email confirmation check
- Authorize Sellers dropdown queries sellers DB table (not inventory[])
- loginAsSeller loads shows from DB so authorized shows appear immediately
- Sidebar overflow fixes — 2-col stat grid, overflow-x hidden, min-width 0
- Shopify CSV import — auto-detected from headers, Tags parsing for grade/grader/year, title splitting
- Location field — box/binder/case slot tracking per card, shown in inventory table and show page
- Sealed Product + Lot support — item type toggle in Add Card modal (Single Card / Sealed Product / Lot / Bundle); type-specific fields and condition options; badges in inventory table and show page
- Admin sidebar seller dropdown sources from DB (`_allSellerHandles` cache) — not in-memory inventory
- Show QR code fix — `buildShowQrUrl()` uses metadata-only payload to stay within QR data limit
- TCG detection expanded — 100+ Pokémon names, rarity keyword regex (Radiant, Reverse Holo, SIR, etc.), MTG/One Piece/Yu-Gi-Oh keywords in both app.html and show.html
- **Sprint 1 cert barcode scanner** — camera overlay with BarcodeDetector (Chrome/Android) + ZXing fallback (iOS Safari); PSA + CGC API lookup via Netlify function; 429 retry with backoff + client Retry button; sport-aware Card Title generation via `buildCardTitle()`
- Netlify secrets scanner fix — Supabase credentials removed from tracked files; injected at build time via `sed` in netlify.toml; `SECRETS_SCAN_OMIT_KEYS` prevents false positives on publishable keys
- **Sprint 2 vision scan** — `scanTakePhoto()` captures canvas frame → JPEG 85% max 1024px → POST to `vision-scan.js` → Claude claude-sonnet-4-6 vision API → two-prompt strategy (sports / TCG) → confidence color coding (green/amber/red) → confirm banner → analytics toast. BGS slabs handled via label reading. No scan limit — unlimited vision scans. Retry logic: 2 failures → auto-fall-through to manual entry.
- **Sprint 3 live card DB autocomplete + cascade wiring** — `trading-card-lookup.js` Netlify function calls Trading Card API (stub/fallback to local CARD_DB when key not set). Upgraded `acSearch()` with 3+ char trigger, 250ms debounce, inline spinner, 8-result dropdown with keyboard nav. Overlay state machine (`photo → processing`) with AbortController cancel support. Slim gold progress bar in Add Card modal header. Session scan history chips (last 5) with re-open. Full cascade wired end-to-end.
- **Scanner UX overhaul** — button renamed "SCAN CARD"; opens directly to photo capture (skips barcode phase); "📷 Take Photo" button full-width, larger, gold with glow; Cert # column widened (grid 1fr 1fr 1.6fr).
- **buildCardTitle integer fix** — `String(val ?? '')` wrapping all fields prevents TypeError when Claude vision returns `year` as an integer; was silently aborting title generation.
- **fillFormFromVision title fix** — `cardTitle` removed from fieldMap; title always synthesized via `buildCardTitle()` from structured fields.
- **fillFormFromScan title fix** — title built from DOM values after form fields are populated, not directly from card object (immune to PSA API field name variations).
- **Mobile viewport/zoom fix** — `maximum-scale=1.0` in viewport meta; `@media (max-width:768px)` forces `font-size:16px` on all inputs/selects/textareas to prevent iOS Safari auto-zoom on focus; `window.scrollTo(0,0)` in `initPage()` ensures page starts at top.
- **Take Photo / Look Up button contrast fix** — both buttons styled with `background:#1a1f2e; color:var(--gold); border:solid var(--gold)` so gold copy is readable on dark background.
- **Admin show seller/card counts** — `updateAscHeader(showId)` now updates all three stat chips (Cards, Sellers, Tables) using `showCardCounts[showId]` for card count (not `inventory[]` which is empty for admins). `addSellerToShow`/`removeSellerFromShow` use surgical DOM updates (no full re-render) to preserve expanded state and call `updateAscHeader()` after each change.
- **renderAdminShowsList() is dead code** — targets `#adminShowsList` which does not exist; all real renders go through `renderAdminShowsDashboard()` targeting `#adminShowsGrid`. Do not call or rely on `renderAdminShowsList()`.
- **saveShow() reads chips for edits** — always reads `#smSellerList .seller-chip.selected` as source of truth; diffs against existing sellers; applies add/remove to DB. Previously ignored chip UI for existing shows.
- **Seller Report tab** — `#sellerTabBar` with `switchSellerTab()`; show-scoped filter, Best sale / Most discounted stat cards, Top 5 by revenue, CSV export via `exportReportCSV()`.
- **XLSX self-hosting** — SheetJS v0.18.5 (`xlsx.full.min.js`) copied to repo root and loaded via `<script src="/xlsx.full.min.js" defer>`. CDN dependency eliminated. `readXLSX()` wraps parse in try/catch; `handleFileUpload()` shows immediate toast and 500ms fallback check.
- **XLSX import `cardFingerprint` fix** — `r.Number` from SheetJS is a JS number; wrapped with `String()` before `.trim()` to prevent TypeError aborting import.
- **Comp check parallel/cardNumber in search query** — `comp-lookup.js` PriceCharting search now appends `card.parallel` to the query string so autos/variants match the correct product. Cache fingerprint expanded to include `cardNumber` and `parallel` so different variants of the same player/year/set are cached independently.
- **Comp pricing staged acceptance** — `_pendingCompChanges` Map stores price decisions; `_stageCompPrice()` stages without DB write; `commitCompPrices()` applies all to DB; "Reprice all out-of-range" button stages all flagged cards at once; gold "Apply N price changes" commit button appears when changes are staged.
- **Mobile seller layout** — `initSidebarState()` now collapses sidebar on ≤768px (removes `sidebar-open`); called in `loginAsSeller()` and `loginAsAdmin()`. `window.scrollTo(0,0)` added to both login functions. Toast `max-width: calc(100vw - 3rem)` prevents overflow on narrow screens.
- **Mobile Add Card FAB** — `#fabAddCard` fixed bottom-right circle (56px, `≤767px` only). Black `#07080c` background, gold border, gold "+" text — high contrast against dark UI. Shown only for sellers; hidden for admin and on sign-out. Toast raised to `bottom: 5.5rem` on mobile to avoid FAB collision.
- **Admin mobile UX** — On `≤599px`: nav name/role hidden, only avatar + sign-out visible; partnership link hidden; gap/padding tightened. Admin sidebar (`#adminShowsPanel` Quick Actions) hidden on mobile — it duplicated the Create New Show CTA in main content. Admin grid collapses to `1fr` so main content fills full width.
- **Buyer comp market value in card modal** — `#modalCompWrap` / `#modalCompContent` inserted inside `.modal-body` after `#modalNotesWrap`. Shows on modal open with skeleton shimmer; comp data fills in asynchronously. `fetchBuyerComp(card)` POSTs to `comp-lookup.js` with an 8s AbortSignal timeout, fails silently. `renderBuyerComp(card, result)` renders market value (Bebas Neue, 2rem), grade tier label, delta badge (deal/fair/high using `DEAL_THRESHOLD=5%` / `HIGH_THRESHOLD=20%`), and up to 3 same-card listings from other sellers in `showInventory` (no DB query — same player + grade + grader + set, excluding current seller and sold cards, sorted cheapest first). Comp section is buyer-only — hidden for `currentRole === 'seller'` or `'admin'`. `closeModal()` resets the section to prevent stale data flash on next open. `CARDSHOW_DEBUG` logs raw comp result to console.
- **Buyer table directory tab** — "Find a Table" tab added to buyer view alongside "Browse Cards". `switchBuyerTab(tab)` toggles visibility of `.filter-bar`, `.results-meta`, `#buyerGrid`, and `#buyerDirectoryPanel`. `buildSellerDirectory()` derives one entry per seller from `showInventory` (no new Supabase queries) — table number from `getTableNumber()`, card count, and category tags (Sports/TCG/Graded/Raw/Sealed/Lot inferred from card data). `buildFullSellerDirectory()` extends this by merging `show.sellers` so sellers with a table assignment but zero uploaded inventory appear as non-clickable rows (`dir-row.no-inventory`). `renderDirectory()` re-renders on tab switch or filter input; supports text search and category dropdown. `directoryOpenSeller(handle)` switches to Browse tab, sets `#filterSeller`, calls `filterBuyer()`, and scrolls card grid into view. Tab resets to Browse on every `joinShow()` call.
- **Add Card type toggle selected state** — Selected tab now `background: var(--card); color: var(--gold); border-bottom: 2px solid var(--gold)`. `acSetType()` applies same styles dynamically. Replaced gold-fill + black-text with gold-on-dark, consistent with all other gold accents in the UI.
- **trading-card-lookup.js parallel mode** — Removed keyword-based Pokémon detection (`looksLikePokemon()`). Now runs `lookupPokemonTCG()` + `lookupPriceCharting()` in parallel via `Promise.all` for every query. pokemontcg.io returns `[]` for sports queries; PriceCharting returns `[]` for TCG queries — safe to merge. Cache key prefix changed from `pricecharting:` / `pokemon:` to `auto:`. Pokémon results listed first in merged output.
- **trading-card-lookup.js PriceCharting parser fix** — `parsePCProduct()` strips `SPORT_PREFIX_RE` ("Baseball Cards", "Football Cards", etc.) from both `name` and `console-name` before extracting fields. When year appears first and no usable `cardSet` exists, leaves `player` empty and returns `rawTitle` (stripped full name) as display fallback. Prevents "Baseball Cards" appearing as player name.
- **Pokémon TCG API integration** — `lookupPokemonTCG(query)` hits `api.pokemontcg.io/v2/cards` with Lucene-style `name:"query*"` search. Optional `POKEMON_TCG_API_KEY` header raises rate limits. Returns normalized `{ id, player, year, cardSet, cardNumber, sport:'Pokemon', parallel, imageUrl }`. Added `POKEMON_TCG_API_KEY` to `.env.example`.
- **show.html buyer view audit fixes** — Three issues fixed: (1) `#debugInfo` element and all JS writing to it removed — raw href/hash debug was visible to real buyers during page load. (2) Stale `isPreview` block removed — `fetchInventoryFromDB` loads all cards from Supabase so the capped-preview message was dead code. (3) `renderSellerRoster()` at-show notice injection guarded with `getElementById` check to prevent duplicate HTML when `renderPage()` runs twice.
- **show.html seller list from DB** — `showMeta.sellers` now rebuilt from actual DB card data after `fetchInventoryFromDB` completes. Previously used URL hash snapshot which went stale when sellers were added/removed after the share link was generated.
- **show.html seller roster redesign** — Replaced initials chips + tooltip with a bordered name list. Each row: gold dot · display name (DM Sans) · `@handle` (DM Mono, muted). `fetchSellerProfiles(handles)` fires a single `SELECT handle, display_name FROM sellers WHERE handle IN (...)` after inventory loads; results populate `sellerProfiles{}` and re-render the roster. Falls back to handle-with-underscores-replaced if no display name is set. No interaction required — all names visible immediately on any screen size.
- **Seller onboarding flow** — 6-step guided overlay firing after first-time seller login. Steps: 0 Welcome checklist, 1 Profile setup (display name/WhatsApp/Instagram), 2 Pre-show checklist, 3 Upload methods, 4 Show day playbook, 5 Ready. Gated by `onboarding_complete boolean DEFAULT false` on sellers table. `checkOnboardingStatus(handle)` called inside `fetchSellerInventoryFromDB().then()` callback in `loginAsSeller()`. `markOnboardingComplete(handle)` writes true on finish or skip. `_openOnboarding()` uses inline `cssText` + `document.body.appendChild(el)` + `z-index:99999` to guarantee overlay visibility (bypasses any CSS stacking/overflow conflicts). `_obSaveProfile()` uses `const { error } = await db.from(...)` pattern — Supabase v2 query builder is not a native Promise, `.catch()` does not work on chained queries. DB migration required: `ALTER TABLE sellers ADD COLUMN IF NOT EXISTS onboarding_complete boolean DEFAULT false;`
- **index.html landing page overhaul (session 2026-07-19)** — Major structural and copy changes:
  - "Which Is You?" interactive section added between problem section and audience triptych — three role cards (Buyer/Seller/Organizer) each showing a relatable pain-point quote, revealing solution on hover (desktop) or tap (mobile). CSS `display:none/flex` toggle with fade-in animation; card grows to fit content (not position:absolute).
  - TCG/Pokémon section moved to immediately after the audience triptych (previously buried below Table Numbers).
  - "Try It Now" demo section added before final CTA with Buyer/Seller/Organizer tabs (`switchTryTab()`), each showing a feature list, role-specific CTA, and UI mockup.
  - Hero pills converted from `<span>` to `<a>` anchor links. Fixed misnamed section IDs: triptych panels had `id="sellers"` on buyer panel and `id="organizers"` on seller panel. Scanner section now has `id="sellers"`, Admin Shows Dashboard has `id="organizers"`, TCG section has `id="tcg"`.
  - Em-dashes removed throughout (marquee, TCG mockup label, profile copy, QR copy, share button mockup).
  - **ShowVision branding** — All references to "AI vision", "AI reads", "AI scanner", "powered by Claude" replaced with "ShowVision" (proprietary product name). Updated in marquee, section label, feature lists, mockup URL bar, demo tab copy. Do not revert to "AI" or "Claude" in user-facing copy on index.html.
  - **Social sharing copy** — "Instagram" as sole platform replaced with "Instagram, X, Facebook, and group chats" in triptych, How It Works step, shareable show page section, and organizer "Which Is You?" card. Section headline changed to "Share to All Your Socials."
  - **Inline CTAs** — 4 gold "Start for Free" / "Join for Free" strips added at regular scroll intervals with distinct hooks. Hero primary CTA changed from "Try the Live Demo" to "Start for Free."
- **Show floor transaction data layer (2026-07-20)** — `show_floor_transactions` table (immutable append-only), `parseShowLocation()` utility, `recordShowTransaction()` called fire-and-forget from `sdConfirm()`, `city`/`state`/`venue` on shows table (DB + in-memory + `saveShow()`), transaction count indicator in seller Report tab. Cross-reference fingerprint match with `price_cache` confirmed. All 8 verification tests passed.
- **Show Floor Transaction Data Layer (Step 3, session 2026-07-19)** — 7 surgical changes to app.html only (Supabase migrations pre-run):
  - `parseShowLocation(locationStr)` — splits freeform "Venue, City, ST" into `{ venue, city, state }`. Used by `showToDbRow()` and `recordShowTransaction()`.
  - `showToDbRow()` — now stamps `city`, `state`, `venue` derived from `parseShowLocation(show.location)` on every show upsert. Hydration path picks these up automatically via `select('*')`.
  - `loadShowsFromDB()` — hydrates `city`, `state`, `venue` from DB rows into `shows{}` in-memory cache.
  - `recordShowTransaction(card)` — new async function inserted after `updateCardInDB()`. Writes one row to `show_floor_transactions` per sale: full card fields, seller UUID + handle, show metadata, table number, `is_test: false`, `api_eligible: true`, `data_version: 1`. Detects sport via `detectCardSport()` (not `detectSport()`). Logs fingerprint to console for price_cache cross-check. All errors caught and console.warn only — never surfaces to seller.
  - `sdConfirm()` — calls `recordShowTransaction(card)` immediately after `updateCardInDB(card)` with **no await**. Fire-and-forget: sold UI completes instantly regardless of Supabase write latency.
  - Report HTML — `<div id="rptTxLog"></div>` added immediately after `#rptPayBreakdown` closing tag.
  - `updateReport()` — renders `"✓ N transactions logged · show floor data synced"` in `#rptTxLog` when `soldCards.length > 0 && activeShowId`; clears otherwise.
  - **Critical constraints:** `recordShowTransaction` must never be awaited from `sdConfirm`. Table is append-only (INSERT + SELECT RLS only, no UPDATE/DELETE). `card_fingerprint` format: `player|year|set|cardNumber|parallel|grade|grader` (7 fields, lowercased, matches price_cache exactly).
- **Show Organizer Analytics Dashboard (session 2026-08-23)** — 📊 Analytics button per show card opens a per-show metrics panel: GMV, sell-through rate, active sellers, seller revenue table, **revenue/sell-through by table number**, top cards sold, seller participation, top searched players, zero-result searches, payment method mix, vs. previous show delta. Revenue-by-table (`_orgRenderTablePerformance`) is fed by `show_sellers.seller_id → table_number`, fetched directly rather than via the handle-keyed `shows{}.tables` cache, so organizers can see which tables actually earn their keep before pricing next show's tables. New `show_events` table logs buyer searches (`filterBuyer()`) and QR scans/show joins (`joinShow()`) fire-and-forget via `_logShowEvent()`. See "Show Organizer Analytics Dashboard" section above for full detail. **Requires the `show_events` DB migration** (see above) — degrades gracefully (shows '—') if not yet run.
- **Auto-Publish on Insert (session 2026-08-23)** — `_autoPublishCardToShow()` fire-and-forget helper wired into all four card-insertion paths (Add Card, Scan-to-Sell POS, bulk scan review, CSV/XLSX import), so cards added mid-show get a `show_inventory` row immediately instead of waiting for the organizer to re-run Publish Inventory. See "Auto-Publish on Insert" section above for full detail, including a deliberate implementation change from the original spec in `upsertCardsToDB()` (captures inserted IDs via `.select('id')` instead of a race-prone re-fetch-by-recency guess).
- **Log a Manual Sale (session 2026-08-24)** — "+ Log a Manual Sale" button in the seller Report tab opens a Sell-Drawer-styled modal for recording off-platform sales. Writes through the same three layers a platform sale does (`inventory`, `show_inventory` via `_autoPublishCardToShow()`, `show_floor_transactions` via a dedicated `recordManualSaleTransaction(card, showId)` wrapper — not `recordShowTransaction()`, since that reads `activeShowId` as a global and a manual sale can target a past show). New `show_floor_transactions.source` column (`'platform'`/`'manual'`/`'community_report'`/`'social_extract'`) tags provenance; MANUAL badge shown in the transaction log via `card._manualSale`. Optional photo capture (camera or library) calls `vision-scan.js` directly (same pattern as `posHandlePhoto()`) to auto-fill Player/Year/Set/Parallel/Grade/Grader before the seller confirms. See "Log a Manual Sale" section above. **Requires the `show_floor_transactions.source` DB migration** (see above).
- **Trading Card API integration (session 2026-08-18/19)** — `TRADING_CARD_API_KEY` went live; see "Trading Card API Integration" section above for full detail. `netlify/functions/tcapi.js` (generic proxy) + `tcapiGet()` helper. Add Card modal's old `#ac_search` free-text box replaced with a 4-step guided picker (player → set → card# → parallel) wired directly to the Player/Set/Card#/Parallel fields. Bulk scan review grid gained a background Trading Card API validation pass (VERIFYING/VERIFIED/UNVERIFIED badge per card, best-effort set/card#/parallel enrichment). Three real API constraints discovered, only the first two on the first pass — the third was found by reproducing a live UI failure end-to-end, not by re-reasoning about the first fix: (1) `filter[x]=` params are non-functional today (silently return the unfiltered collection) on both `/v1/cards` and `/v1/sets`; `trading-card-lookup.js`'s old `filter[name]` search was broken the same way, meaning `#ac_search` had been silently returning wrong results since the key went live — removing it fixed that exposure as a side effect. (2) `filter[player_id]` on `/v1/cards` is real and documented but too slow for interactive use (10s+, no fast alternative). (3) The plain `full_name=`/`name=` params only prefix-match a first-name token — a last-name token never prefix-matches at any length short of complete, and `/v1/sets?name=` has no partial matching at all — so player search reports a "still typing the last name" state instead of substituting an unrelated candidate list when a multi-word query comes up empty, and set search fetches+caches the whole 273-set catalog client-side instead of relying on the server to filter it. An earlier version of the player-search fix tried a first-word-only fallback, which silently showed unrelated players with nothing distinguishing them from real matches — worse than showing nothing, and cut once this was caught.
- **Trade Zone (session 2026-08-25)** — guest-friendly show-floor trading, fully standalone from the rest of the platform (`trade_zone_shows`/`traders`/`trade_posts`/`trades`/`share_events` never touch `inventory`/`shows`/`show_sellers`/`show_inventory`). Anonymous Supabase Auth for zero-friction guest identity, client-side photo resize + Storage upload, a live board (`trade-board.html`, Realtime `postgres_changes`) plus an interactive personal board in `trade-zone.html`, two-sided trade propose/confirm funneled entirely through `SECURITY DEFINER` RPCs (not direct table writes — see "Trade Zone" section above for why), a client-side Canvas-composited branded share graphic with consent-gated handle display and Web Share API integration, OG-tagged social previews via `netlify/functions/trade-og.js`, and a claim flow that upgrades the anonymous session in place via `supabase.auth.updateUser()` (same `auth.uid()`, zero data migration). Every RLS policy and RPC — including the security-critical paths (forged-post rejection, direct-`trades`-update rejection, non-party confirm rejection, consent-gated handle exposure, share-image URL folder validation) — was verified against a real local Postgres instance with a minimal Supabase-shape stub before shipping. **Requires the `supabase/migrations/20260825120000_trade_zone.sql` migration** (schema, storage buckets, RLS, RPCs) and enabling Anonymous Sign-Ins in the Supabase dashboard (Authentication → Providers → Anonymous).
- **Photo Scan & Card Fingerprinting (session 2026-08-27)** — new `netlify/functions/scan-card.js` (separate from `vision-scan.js` — its prompt distinguishes a graded slab's cert number from the card's own printed serial number, which the fingerprint depends on). Wired into Scan-to-Sell POS review and the Manual Sale modal's existing photo-capture buttons (not the literal Sell Drawer, which has no card-identity fields to autofill — see "Photo Scan & Card Fingerprinting" section above for that deviation). `computeCardFingerprint()` (cert+grader, or a SHA-256 composite fallback) + `checkDuplicateFingerprint()` (scoped to the seller's own inventory) flag a non-blocking "already in your inventory" warning. Low-confidence fields (<0.7) get a yellow `.scan-verify` border. Manual Sale modal gained a new Cert # field (`#mslCert`) it previously lacked. **Requires the `inventory.fingerprint`/`detected_confidence` DB migration** (see above) — degrades gracefully (no dupe warning, no error, on every insert/update path via `_isMissingScanColumnError()`'s retry-without-those-columns fallback — see "Resilience to a not-yet-run migration" under "The Drop" below) if not yet run.
- **"The Drop" — post-sale share card (session 2026-08-27)** — post-sale prompt bar (`sdConfirm()`/`confirmManualSale()`, gated by a `localStorage` opt-in preference set in the Profile modal) plus a 📤 button on every Report tab transaction row, both opening a share-card modal: a **required card photo step** (Take Photo/Choose from Library, client-side only) gates a three-style canvas renderer (Dark/Light/Minimal) that composites the photo into the card, an editable caption with a fixed CardShow-handle+hashtags footer appended after it, and copy/download/native-share actions. **Payment method is never drawn on the card image or included in the caption** — only price and venue. No new DB table or Storage bucket — fully client-side canvas compositing, matching `js/trade-share.js`'s conventions but duplicated rather than shared (no build step to share a module from). See "The Drop" section above for full detail.

### Tier 1 — Ship before beta show
- **Tighten RLS policies** (urgent, high complexity) — replace `using (true)` with `auth.uid() = seller_id`
- ~~**eBay comp lookup at card entry**~~ — replaced by PriceCharting + TCG API comp check (see Comp Pricing section)

### Tier 2 — First show retrospective
- ~~**Sprint 2 vision scan**~~ — shipped
- ~~**Sprint 3 live card DB autocomplete**~~ — shipped (see Shipped section above)
- Card Ladder API integration (high complexity) — partnership outreach needed, no public API
- Quick mark-sold button (low complexity)
- Price refresh before show (medium complexity)
- Per-show card selection toggle (medium complexity)
- Post-show summary for sellers (low complexity)
- Show page from DB — removes 50-card hash cap (high complexity)

### Tier 3 — Growth and monetisation
- Want list / saved cards for buyers
- Dealer-to-dealer transfer (QR handoff)
- Stripe billing ($49/show organizer tier)
- Offer system (buyer broadcasts want to all sellers)
- ~~**Organizer analytics dashboard**~~ — shipped (see Shipped section above)

### Tier 4 — Long game
- TCDB card database integration (3M+ card autocomplete)
- Multi-show inventory search for buyers (requires show page from DB first)

### Immediate actions outside the platform
- Beta test at organizer's next show — respond with concrete proposal
- Card Ladder partnership outreach — co-marketing deal for comp data access

## Social Proof Section (#social-proof)
Location: index.html, between the CSV-format stat row and the Final CTA / footer.
Purpose: Grows over time as CardShow gets press, show partnerships, and industry features.

Current entries (as of August 2026):
- Enter the Inferno pitch competition, NSCC 2026 (featured badge + logo tile)
- The National Sports Collectors Convention (logo tile)
- InfernoRed Technology (logo tile)
- Sports Cards Live / Jeremy Lee (logo tile)

To add a new entry:
1. Add a `<div class="sp-logo-tile">` block to `.sp-logo-strip` in index.html
2. If the partner has a logo PNG, use an `<img>` tag inside the tile instead of `.sp-tile-name` text
3. Update this CLAUDE.md entry with the new partner and date added

Featured badge: update `.sp-featured-card` content when a more prominent featured event
supersedes Enter the Inferno (e.g., a major press feature or named partnership). Keep
Enter the Inferno as a logo tile even after the featured badge is updated.

`.sp-featured-img` references `/assets/enter-the-inferno-promo.png`, which is now committed
to the repo (`assets/` is the first image asset directory in this codebase — everything
else prior to this section is emoji + CSS mockups).

## Scan-to-Sell POS — Photo-First (shipped)

Lets a seller record a walk-up table sale for a card that was never pre-uploaded
to inventory: photograph the card, review the auto-filled details, then hand off
to the *existing* Sell Drawer (`openSellDrawer()` / `sdConfirm()`, unchanged) to
capture price/payment and mark it sold. This replaced an earlier multi-session
build-out of a custom scan → barcode → payment-grid POS modal (manual entry,
BarcodeDetector/ZXing barcode scan, PSA cert lookup, then Claude-vision single-card
scan) — that design was fully reverted before shipping (see "Notable deviations"
below) in favor of this smaller design that reuses the sell drawer instead of
duplicating its price/payment UI.

### Flow
```
#fabScanToSell (mobile only, seller view) → posOpenPhotoSheet()
  └─ #posOverlay/#posSheet bottom sheet opens, #posPhotoPhase shown
       ├─ "Take Photo" → posTriggerCamera() → hidden #posFileInput (capture="environment")
       ├─ "Choose from Library" → posTriggerLibrary() → hidden #posLibraryFileInput
       │    (identical accept="image/*" but NO capture attribute — that's what makes
       │    mobile browsers open the photo picker instead of jumping straight to camera)
       │    Both inputs share the same onchange="posHandlePhoto(this)" handler — it
       │    only reads inputEl.files[0], so it doesn't care which source produced it
       │         └─ posHandlePhoto(inputEl)
       │         ├─ _posCompressImage(file) — canvas resize, max 1024px, JPEG 85%
       │         │    (same compression convention as scanTakePhoto())
       │         └─ POST /.netlify/functions/vision-scan { image, mediaType }
       │              directly via fetch() — NOT through _callVisionScan(), which
       │              is hard-coupled to the Add Card modal's cert-scanner overlay
       │              and would drive the wrong UI entirely if reused here
       │              ├─ success            → posShowReview(card, result)
       │              └─ !success / low_confidence → _posShowLowConfidence(result)
       │                   (vision-scan.js returns no `card` at all on this path —
       │                   nothing to pre-fill, so this just restores the photo UI)
       └─ "Enter card details manually" → posShowManualPhase()
            (skips the photo/vision step entirely, opens #posReviewPhase blank)

#posReviewPhase — Player/Year/Set/Card#/Parallel/Grade/Grader/Cert#/Asking Price,
  confidence badge (high/medium/low, computed as the worst of vision's per-field
  confidence ratings — see "Confidence" below), "Retake" link, Cancel button
       └─ "Looks Good — Record Sale →" → posInsertAndOpenDrawer()
            ├─ blocks with a toast if Player is empty — no insert attempted
            ├─ builds a card object with the CardShow-standard field names
            │    ('Card Title', Player, Year, 'Set ', Number, 'Parallel/Variant',
            │    Grader, Grade, 'Cert #', Price, Status:'Available', Seller,
            │    item_type:'card') — same shape saveAddCard()'s card branch uses
            ├─ runs it through validateAndNormalizeCard() (grader/grade normalization),
            │    same as every other card-creation path in the app
            ├─ await insertCardToDB(card); card._dbId = <returned uuid>
            │    (insertCardToDB() does not mutate its argument — the caller must
            │    capture and assign _dbId itself, or later updateCardInDB() calls
            │    — which sdConfirm() makes when the seller completes the sale —
            │    silently no-op forever; see Critical Note 3)
            ├─ inventory.push(card)
            └─ openSellDrawer(cardIdx) — the *existing*, unmodified Sell Drawer.
                 Seller enters price/payment there; sdConfirm() (unmodified) does
                 the rest: Status→'Sold', updateCardInDB(), recordShowTransaction()
                 fire-and-forget, syncBuyerView(), updateStats(), updateReport().
```

### Field-name / confidence mapping (why this isn't a copy-paste of vision-scan callers)
`vision-scan.js`'s success response is `{ success, card, isTCG, promptVariant, rawResponse }`
where `card.cardSet` (not `card.set`) and `card.cardNumber` (not `card.cardNum`) are the
real field names, and `card.confidence` is a **nested object** —
`{ player, year, cardSet, cardNumber, parallel, grade }`, each `'high'|'medium'|'low'` —
not a flat top-level rating. `posShowReview()` reads these exact nested names.
`_posOverallConfidence(card)` derives one badge level as the worst of those six ratings
(`low` if any field is low, else `medium` if any is medium, else `high`) — matching how
`fillFormFromVision()` treats the same nested shape elsewhere in the app. Grader values
from vision are lowercase; `posShowReview()` uppercases them before assigning to the
`<select>`, whose option values are `PSA`/`BGS`/`CGC`/`SGC`.

### Card Title
Built via the real `buildCardTitle({player, year, cardSet, cardNum, parallel, sport, rawTitle})`
call shape (same one `fillFormFromVision()` uses) — note `buildCardTitle()` never reads
grader/grade at all, for either the sports or TCG title branches, so they're correctly
omitted from this call rather than passed in and silently ignored.

### Cancellation
`_posVisionAbort` holds the in-flight vision `fetch()`'s `AbortController`. `posCancelVision()`
and `posClose()` both abort it before touching UI state, so a slow vision response can never
land after the seller has already cancelled, retaken, or closed the sheet.

### Photo source — camera vs. library
`#posPhotoBtn` ("Take Photo") and `#posLibraryBtn` ("Choose from Library") sit stacked
in `#posPhotoPhase`, both visible by default. `posTriggerCamera()`/`posTriggerLibrary()`
click their respective hidden `<input type="file">` — the only difference between them
is the `capture="environment"` attribute on `#posFileInput`, absent on
`#posLibraryFileInput`. That one attribute is what makes a mobile browser jump straight
into the camera app for one and open the photo library/file picker for the other; no
other code differs, since `posHandlePhoto()` is source-agnostic. Every phase-transition
site that used to show/hide `#posPhotoBtn` + `#posLoading` + the manual-entry link
together now goes through one of three shared helpers so `#posLibraryBtn` stays in sync
with them automatically: `_posShowPhotoOptions()` (both buttons + manual link visible,
loading hidden), `_posShowLoading()` (inverse, while vision is running), and
`_posHidePhotoOptions()` (everything hidden, used only when manual entry is chosen).
`posRetakePhoto()` returns to this same choice screen rather than re-opening the camera
directly (its original behavior, from before the library option existed) — assuming
"retake" always means "camera" stopped being safe once a photo can also come from the
library, so it now lets the seller pick either source again.

### Insert timeout (fixes: Confirm button stuck on "Saving…")
`posInsertAndOpenDrawer()` races `insertCardToDB(card)` against a `POS_INSERT_TIMEOUT_MS`
(8000ms) timer via `Promise.race()`. Without this, a stalled connection — common on
show-floor wifi — left the awaited insert call pending forever, and with it the Confirm
button permanently disabled on "Saving…" with no way to continue. On timeout, the flow
falls through to the same "saved locally — sync to server failed" degradation path
already used for a genuine insert failure (`dbId` is `null` either way) and proceeds to
the Sell Drawer immediately rather than blocking a live sale on a slow network. The
original insert request is left running in the background if it hasn't failed outright;
if it does eventually resolve, nothing reads its result anymore since the caller has
already moved on. `_posReset()` also now explicitly restores the Confirm button's
disabled state and label — it previously only reset the review fields, so a slow/failed
save that later got reset via `_posReset()` (closing the sheet, or opening it fresh for
the next sale) would leave a *second* transaction's Confirm button stuck too.

### Does not change
Sell Drawer / `sdConfirm()` / `openSellDrawer()`, `vision-scan.js`, `_callVisionScan()`,
`fillFormFromVision()`, Add Card modal, RLS policies. No barcode scanning, no PSA cert API
integration, no new Supabase tables or migrations — POS writes to the same `inventory` table
(and, via the unmodified sell-drawer confirm path, `show_floor_transactions`) the rest of the
app already uses.

### FAB visibility
`#fabScanToSell` (mobile only, `≤767px`, fixed bottom, stacked above the circular
`#fabAddCard` "+" button via `bottom: calc(5.75rem + env(safe-area-inset-bottom,0px))`)
follows the exact same show/hide pattern as `#fabAddCard`: cleared (`style.display=''`)
in `loginAsSeller()`, set to `'none'` in `loginAsAdmin()` and `signOut()`. `enterAsBuyer()`
doesn't need to touch it — like `#fabAddCard`, it starts hidden by default and is only ever
shown from `loginAsSeller()`, never reached from a fresh anonymous buyer session. Mobile
`.toast` bottom offset raised to `9.5rem` to clear both stacked FABs. `--gold` is not a real
CSS variable (see the Critical Note in the Trading Card API section below) — all new POS
CSS uses the real `var(--accent)` token instead.

### Notable deviations from the original design drafts (and why)
An earlier build-out across several sessions added a materially different design on this
same branch — a custom Phase 1 (manual entry) / Phase 2 (payment grid) POS modal with its
own barcode-scan camera stack (BarcodeDetector + ZXing fallback) and, briefly, a PSA cert
API lookup (removed once PSA API access turned out not to be available — barcode scan was
cert-number extraction only from that point on), then a Claude-vision single-card scan
bolted onto the *bulk-scan Supabase Edge Function* via a new `mode=single` param. That
whole design was fully reverted (`git checkout origin/main -- app.html
supabase/functions/bulk-scan/index.ts CLAUDE.md`) before ever merging, in favor of this
photo-first design, because the newer spec's element IDs (`#posOverlay`/`#posSheet`) and
overall architecture directly collided with what was already built, and duplicating
price/payment capture in a new custom UI was redundant with the sell drawer that already
does exactly that job. `supabase/functions/bulk-scan/index.ts` is untouched by this
feature — single-card identification goes straight to `vision-scan.js` instead.

Cross-referencing the actual `vision-scan.js`/`insertCardToDB()`/`buildCardTitle()`/
`cardToDbRow()` source before implementing (rather than trusting the draft spec's
inline code samples verbatim) caught six concrete bugs before they shipped: two
field-name typos (`Parallel`/`Cert` instead of the real `'Parallel/Variant'`/`'Cert #'`),
a missing `Number` field on the saved card object, a missing `card._dbId` capture
(would have silently broken every later `updateCardInDB()` call for a POS-created
card), a broken confidence-badge derivation (scanned card values for literal
`"high"/"medium"/"low"` strings instead of reading the real nested `confidence` object),
and a `buildCardTitle()` call using the wrong field names (`set`/`cardNumber` instead
of `cardSet`/`cardNum`). All six are fixed in the shipped implementation.

## Log a Manual Sale

Lets a seller record a sale that happened off-platform or was never captured by CardShow
(cash sale outside the app, sale at a different show, a trade converted to cash, etc.)
via **"+ Log a Manual Sale"** in the Report tab. The sale still propagates through the
same three data layers a normal Sell Drawer sale does — `inventory`, `show_inventory`,
`show_floor_transactions` — just tagged `source: 'manual'` on the transaction row so it
can be told apart from a platform-captured sale in reporting/analytics later. The modal
also has an optional photo capture step (camera or library) that runs the same vision
identification `vision-scan.js` uses elsewhere in the app to auto-fill Player/Year/Set/
Parallel/Grade/Grader — see "Photo capture" below.

### DB migration
See "DB Migration: show_floor_transactions.source" above — required before this feature's
transaction writes succeed.

### Entry point
`#manualSaleOverlay` — a `.drawer-overlay`/`.drawer` modal reusing the Sell Drawer's CSS
classes (`.drawer-handle`, `.drawer-header`, `.drawer-body`, `.drawer-field-label`,
`.sold-price-wrap`, `.payment-grid`, `.pay-opt`, `.sale-notes-input`, `.btn-confirm-sale`,
`.btn-cancel-sale`) for visual consistency, rather than a new custom UI. Opened via
`openManualSaleModal()` from the `.btn-log-manual-sale` button in `#reportShowSelector` —
the Report tab's header row, alongside the show filter and Export CSV button (pushed to
the row's right edge via `margin-left:auto`). Originally shipped as an outlined button
lower in the panel, above the Transaction Log card; moved to the header and restyled as a
solid `var(--accent)` fill (matching `.btn-primary`'s visual weight) so it reads as a
primary action instead of a secondary link — it's now visible without scrolling and no
longer competes visually with the ghost-styled Export CSV button next to it. The helper
text that used to sit under the button ("Record a sale that happened off-platform or
wasn't captured by CardShow") is now a `title` tooltip on the button instead, since the
compact header row has no room for a second line.

### Flow
```
openManualSaleModal()
  resets all fields, _mslPopulateShowSelector() (seller's authorized shows,
  newest-first, pre-selected to activeShowId), focuses Player

confirmManualSale() — validates Player + Sold Price + Payment Method, then:
  1. validateAndNormalizeCard() + buildCardTitle({player, year, cardSet,
     parallel, cardNum:'', sport:'', rawTitle:''}) — cardSet/cardNum,
     not set/cardNumber; grader/grade never passed (buildCardTitle ignores them)
     card._manualSale = true — flags the MANUAL badge in the transaction log
  2. inventory.push(card) — before any await, so the Report tab reflects
     the sale instantly regardless of Supabase latency
  3. insertCardToDB() raced against POS_INSERT_TIMEOUT_MS (same pattern as
     posInsertAndOpenDrawer()) — card._dbId manually assigned from the
     returned UUID, since insertCardToDB() does not mutate its argument
  4. updateCardInDB(card) fire-and-forget — writes sold_price/payment_method/
     sale_notes/sold_time onto the inventory row (this is what makes the
     sale show up in organizer analytics' GMV, which reads sold_price off
     the inventory row via the show_inventory join)
  5. _autoPublishCardToShow(card, dbId, targetShowId) fire-and-forget —
     targetShowId is the explicitly selected show, or activeShowId if none
     picked; skipped entirely for an off-show sale (no show selected)
  6. recordManualSaleTransaction(card, targetShowId) fire-and-forget —
     see below
  7. closeManualSaleModal() + renderSellerTable() + updateStats() +
     updateReport() + syncBuyerView()
```

### Photo capture (optional, auto-fills fields)
The modal leads with a compact "📷 Take Photo" / "🖼 Choose from Library" row above the
Show selector — same dual-source convention as Scan-to-Sell POS (`capture="environment"`
on the camera input, absent on the library input). Calls `vision-scan.js` **directly**
via `fetch()`, the same way `posHandlePhoto()` does — `_callVisionScan()` is hard-wired to
the Add Card modal's cert-scanner overlay and would drive the wrong UI if reused here.
Reuses two existing generic helpers rather than duplicating them: `_posCompressImage(file)`
(canvas resize to 1024px, JPEG 85%, state-free) and `_posOverallConfidence(card)` (worst of
vision's per-field confidence ratings).

- `mslTriggerCamera()` / `mslTriggerLibrary()` — click the two hidden `<input type="file">`s
- `mslHandlePhoto(inputEl)` — compress → POST `/.netlify/functions/vision-scan` →
  `_mslApplyVisionResult(card, base64)` on success; on `low_confidence`/failure, restores
  the idle photo buttons and toasts rather than leaving the loading state stuck
- `_mslApplyVisionResult(card, base64)` — fills **Player/Year/Set/Parallel/Grade/Grader**
  (`fill()` helper, mirrors `posShowReview()`'s field-name mapping — `card.cardSet`, not
  `card.set`). The modal's Number/Cert # fields don't exist in this quick-entry form (see
  `confirmManualSale()` above), so nothing from the scan is mapped to them even if vision
  detected them — same omission as manual typing already has, not a regression.
  Filled fields get the existing `.db-filled` green-left-border convention (Add Card
  picker, bulk-scan verify) rather than POS's separate `.pos-filled` class, since this
  modal isn't part of the POS UI. Shows a 48×48 thumbnail with a Retake link after a
  successful scan.
- `_mslResetPhoto()` — called from `openManualSaleModal()`; aborts any in-flight fetch,
  clears both file inputs, returns the photo section to its idle button state.
  `closeManualSaleModal()` also aborts an in-flight fetch, so closing mid-scan can't land
  a result after the modal is gone.
- A photo is **never uploaded to Supabase Storage or attached to the transaction row** —
  it exists only in the browser tab as a base64 string used for the vision call and the
  thumbnail preview, then is discarded (matches `_posLastResult`'s POS precedent — no
  photo persistence anywhere in this app's card-identification flows).

### `recordManualSaleTransaction(card, showId)`
**Not a thin wrapper around `recordShowTransaction()`** — that function reads `activeShowId`
as a global with no parameter to override the target show or add a `source` value, and a
manual sale can target a past show the seller isn't currently viewing. Calling it here would
either use the wrong show or require modifying it, and `recordShowTransaction()` sits on
`sdConfirm()`'s hot path and must never be touched for this. So the row is built manually
instead — shape mirrors `recordShowTransaction()` field-for-field (confirmed by reading that
function's source before writing this one), plus `source: 'manual'`. Uses `detectCardSport()`
(API-routing, full TCG keyword detection) — not `detectSport()`, which is UI-badge-only.
Fire-and-forget, like every other write to the immutable `show_floor_transactions` table in
this app. `recordShowTransaction()` itself is completely untouched.

### Off-show sales
If the seller leaves the Show selector on "Off-show / no show", `targetShowId` is `null`:
`_autoPublishCardToShow()` and `recordManualSaleTransaction()` are both skipped entirely
(no show to attribute the sale to) and the sale lives only in `inventory`/the seller's
lifetime Report — same graceful-degradation shape as every other "no show" path elsewhere
in this app.

### MANUAL badge
`updateReport()`'s transaction-log row renderer checks `r._manualSale` and prepends a
`.msl-badge` ("MANUAL") next to the player name when true — the only change to that
function; every other column is untouched.

### CSS
`.btn-log-manual-sale`, `.msl-badge`, and the `.msl-photo-*` photo-capture classes all use
`var(--accent)` — `var(--gold)` is not a real CSS variable in this codebase (see the
Critical Note in the Trading Card API section). Photo buttons/loading/preview use compact,
purpose-built `.msl-photo-*` styles rather than POS's large `.pos-photo-btn` (160px min-height)
— the photo option is supplementary to a form here, not the primary flow like it is in POS.

### Prerequisite
`_autoPublishCardToShow()` (from `feature/auto-publish-on-insert`) must already exist —
this feature calls it as-is and never modifies it.

### Does not change
`recordShowTransaction()` · `sdConfirm()` · `openSellDrawer()` / `closeSellDrawer()` ·
`publishShowInventoryToDB()` · organizer analytics functions · any Netlify function ·
RLS policies. `updateReport()` changes only the single `<td>` player-name cell.

## Photo Scan & Card Fingerprinting

Lets a seller photograph a single card during **Scan-to-Sell POS** or the **Manual Sale
modal** to auto-fill its details, and computes a fingerprint per scan so a likely-duplicate
(the same card already in the seller's inventory) can be flagged non-blockingly. This is a
separate capability from the existing Add Card modal cert scanner (`vision-scan.js`,
`_callVisionScan()`, `fillFormFromVision()`) — those are untouched.

### Why a separate Netlify function (`scan-card.js`), not vision-scan.js
`vision-scan.js`'s prompt returns a single ambiguous `certNumber` field with no instruction
distinguishing a graded slab's cert number from the card's own printed serial (e.g. "45/99")
— those are frequently confused, and this feature's fingerprint depends on getting the
distinction right (cert number + grading company is the strong fingerprint key). `scan-card.js`
explicitly separates `cert_number` from `parallel_serial` in its prompt and confidence
shape. It also returns numeric 0.0-1.0 confidence per field (not vision-scan.js's
high/medium/low strings) — `_scanOverallConfidence()` / `_scanFlagConfidence()` work off
that scale, with `SCAN_CARD_CONFIDENCE_THRESHOLD = 0.7`.

`scan-card.js`'s JSON shape also includes `card_number` — a bonus field beyond the original
feature spec, added because Scan-to-Sell POS's review form already has a Card # field every
other identification path in this app fills, and dropping it would be a real regression.
`card_number` plays no part in `computeCardFingerprint()`.

### UX — deviation from "the sell drawer, above the manual entry fields"
The literal Sell Drawer (`sellDrawerOverlay` / `sdConfirm()`) only captures price + payment
for a card **already in inventory** — it has no player/set/grade fields to autofill at all,
so a "Scan Card" button there would have nothing to do. **Scan-to-Sell POS**
(`posOverlay`/`posReviewPhase`) is this app's actual "sell flow with manual entry fields" —
it already chains photo → identify → review → the real sell drawer — so this feature's
scan capability lives there instead, reusing the existing "Take Photo" / "Choose from
Library" buttons (`posTriggerCamera()`/`posTriggerLibrary()`) rather than adding a
redundant third button. The Manual Sale modal already had its own photo-scan buttons for
the same reason — both were repointed at `scan-card.js` (see below) rather than adding new UI.

### Client flow (both POS review and Manual Sale modal)
```
Tap "Take Photo" / "Choose from Library" (existing buttons — capture="environment" vs. not)
  ↓
_scanCardCompressImage(file) — canvas resize, max 1600px long edge, JPEG q=0.85
  (larger than the Add Card scanner's/POS's old 1024px cap — grading-label cert-number
  text needs more resolution to stay legible at that field's size on the card)
  ↓
POST base64 to /.netlify/functions/scan-card
  ↓
Response: { success, card: { player_name, year, set_name, subset, card_number,
  parallel_name, parallel_serial, autograph, grading_company, grade, cert_number,
  confidence: { player_name, year, set_name, grade, cert_number } } }
  ↓
Form auto-fills (posShowReview() / _mslApplyVisionResult()) — parallel_serial and an
  Auto flag are folded into the free-text Parallel field, matching how that field already
  conflates variant info everywhere else in this app (e.g. "Gold Refractor Auto")
  ↓
_scanFlagConfidence(el, confidenceValue) — yellow .scan-verify border + "please verify"
  title tooltip on any filled field whose confidence is < 0.7 or missing. Cleared on focus.
  Never silently trusts a low-confidence guess without the seller seeing it flagged.
  ↓
computeCardFingerprint(card) → checkDuplicateFingerprint(fingerprint)
  → _scanRenderDupeWarning() — non-blocking "This looks like a card already in your
  inventory (added [date])" banner. Seller can always proceed anyway — re-scans and
  previously-sold/re-consigned cards are legitimate.
```

### Fingerprint
`computeCardFingerprint(card)` (app.html) — cert number + grading company is the strong,
preferred fingerprint (`"{GRADER}-{CERT}"`, uppercased); falls back to a SHA-256 digest of
`year|set_name|subset|parallel_name|parallel_serial|player_name` (lowercased, whitespace
stripped) for raw cards or illegible labels. Returns `null` if neither branch has anything
usable — never fingerprints an empty card.

Computed **twice** per card, deliberately: once immediately after the scan (for the
duplicate-check banner, using the raw scan response) and again at insert/confirm time from
the **final, possibly seller-edited** DOM field values (for the fingerprint actually
persisted to the row) — matching this app's existing "read live DOM, not the original scan
snapshot" convention (see the bulk-scan correction pass). The scan-time fingerprint is
never itself written to the database.

`checkDuplicateFingerprint(fingerprint)` — scoped to the **current seller's own inventory**
only (`seller_id` + `fingerprint` match); a fingerprint match on a different seller's card
isn't a duplicate this seller needs to know about. Degrades to `null` (no warning, no
error surfaced) if the `fingerprint` column doesn't exist yet, `db` is unavailable, or the
query otherwise fails — see the migration note above.

### DB persistence
`fingerprint` and `detected_confidence` flow through `cardToDbRow()`/`dbRowToCard()` exactly
like every other card field (`card.Fingerprint` / `card.DetectedConfidence` in memory).
`detected_confidence` is a pure audit trail of the raw scan response's confidence object —
it is set only when a scan actually ran (`null` for manually-typed cards) and plays no role
in any current UI; it exists for future analysis of scan accuracy. Both columns require the
migration above — until it's run, inserts/updates simply write `null` for cards without it
(no error), and existing pre-migration rows read back as `Fingerprint: null` — the Report
tab's share button (see "The Drop" below) works identically with or without a fingerprint.

### Key functions (app.html)
- `_scanCardCompressImage(file)` — canvas resize/compress, shared by both entry points
- `computeCardFingerprint(card)` / `checkDuplicateFingerprint(fingerprint)`
- `_scanOverallConfidence(card)` / `_scanFlagConfidence(el, confidenceValue)`
- `_scanRenderDupeWarning(containerEl, dupe)`
- `posHandlePhoto()` / `posShowReview()` — POS review phase, `#posDupeWarning` banner
- `mslHandlePhoto()` / `_mslApplyVisionResult()` — Manual Sale modal, `#mslDupeWarning`
  banner, new `#mslCert` field (the modal previously had no cert-number input at all)

## "The Drop" — post-sale share card

Lets a seller generate a branded, shareable graphic + caption immediately after confirming
a sale (Sell Drawer or Manual Sale), or later from the Report tab's transaction log. Fully
client-side canvas compositing, no Storage upload and no new DB table — the image is
downloaded/shared directly from the browser, not persisted server-side.

**Payment method is never drawn on the card image or included in the caption** — only price
and venue. This was called out explicitly because the card visual's price line originally
read `"$4,800 / CASH · Long Beach"`-shaped output in the design spec; `renderShareCard()`
and `generateCaptionBody()` both draw only from `card.SoldPrice`/`card.Price` and the show's
venue/city — `card.PaymentMethod` is never referenced by either.

### Entry points
1. **Post-sale prompt** — `showDropPrompt(card, showId)`, a 48px auto-dismissing (6s) bottom
   bar (`#dropPromptBar`), fired from `sdConfirm()` (gated: only when the opt-in preference
   is `'always'`) and from `confirmManualSale()` (gated: `'always'` or `'manual_only'`).
   "Create Share Card" opens the modal; the dismiss `✕` or the 6s timeout just hides the bar.
2. **Report tab** — a 📤 button in every `#rptTxBody` transaction-log row calls
   `openShareCardModal(inventory[idx])` directly, with no gating by the opt-in preference
   (that preference only controls the automatic post-sale prompt, not an explicit request).
   Works identically for sales logged before this feature shipped — `openShareCardModal()`
   never reads `card.Fingerprint` or anything else this feature might not have backfilled.

### Card photo — required before a post can be created
Every share card must include a photo of the card. `openShareCardModal()` checks
`card._dropPhotoDataUrl`: if unset, `#dropPhotoSection` (📷 Take Photo / 🖼 Choose from
Library, same dual-input `capture="environment"`-vs-not convention as POS/Manual Sale) is
shown and `#dropShareBody` (canvas, style picker, caption, share actions) stays hidden —
none of those are reachable without a photo first. `_dropHandlePhoto()` reads the file via
the existing `_readFileAsDataURL()` helper (already used by the bulk-scan source-image
lightbox) and stores the data URL directly on the in-memory card object, then calls
`_dropRenderReady()` to render the canvas and reveal the share body. `_dropChangePhoto()`
clears it and returns to the photo step.

The photo is **client-side only, never uploaded to Storage or persisted to the DB** —
matches this app's existing convention for card-identification photos (POS/Manual Sale/Add
Card scanner) of using a photo in-browser only, then discarding it. Because it's stored on
the card object itself (not a page-scoped variable), it does survive reopening the modal for
the same sale later in the same session — e.g., tapping the Report tab's 📤 button for a
sale you already added a photo to earlier — but is lost on page reload like every other
in-memory-only field in this app (`_dbId`, `_shows`, etc.).

### Style picker + canvas renderer
`renderShareCard(canvas, card, style, venueLabel)` — one function, three themes (`dark` /
`light` / `minimal`). Now `async`: when `card._dropPhotoDataUrl` is set it awaits
`_dropLoadImage()` and draws the photo into a bordered, contain-fit box at the top of the
card before drawing text (player, set/parallel/grade, price, venue, wordmark) below it —
`_dropWrapText()`'s return value chains each block's Y position off the previous one so nothing
overlaps regardless of photo/text lengths. Re-renders the same 1080×1350 canvas on every
style-chip tap (`_dropSetStyle()`) — purely local, no DB write. `_dropWrapText()` is a
small duplicated (not shared) canvas text-wrap helper, same convention as `js/trade-share.js`'s
`_drawWrappedText()` — this app duplicates small canvas helpers across files/features rather
than sharing a module, since there's no build step to share one from. `_dropRenderReady()`
awaits the full render (photo load included) before revealing `#dropShareBody`, so Download/
Share can never read a canvas that's still mid-draw.

### Caption
Split into an editable body (`generateCaptionBody()`, the "Just sold this..." sentence) and
a fixed footer (`generateCaptionFooter()` — "Tracked on @cardshow.io" + a player hashtag +
core hashtags) that is appended after the editable `<textarea>`, never merged into it — so
CardShow's handle and hashtags persist even if the seller rewrites their own caption text.
`_dropUpdateCounters()` shows two live character counters (Instagram 2200, X 280) against
the **combined** body+footer length, turning red past each platform's limit.

### Actions
`_dropCopyCaption()` (clipboard), `_dropDownloadImage()` (canvas → PNG blob → download
anchor), `_dropNativeShare()` (Web Share API with the PNG as a file, when
`navigator.share`/`canShare` exist — the button is hidden otherwise, same feature-detection
pattern as `js/trade-share.js`'s share row).

### Opt-in preference
Device-level via `localStorage` (`dropPromptPref`), no DB column — same pattern as every
other client-only preference in this app. Three values: `'always'` / `'manual_only'` /
`'never'`. `getDropPromptDefault()` returns `'manual_only'` once a seller has been
authorized for 3+ shows (`_dropGetSellerShowCount()`), `'always'` otherwise — an established
seller is assumed to already know the feature exists. Radio group lives in the Profile
modal (`#dropPrefGroup`, synced on `openProfile()`), CardShow's closest existing analog to a
seller settings panel — there is no separate Settings page in this app.

### Key functions (app.html)
- `showDropPrompt()` / `_dropPromptYes()` / `_dropPromptDismiss()`
- `openShareCardModal(card, showId)` / `closeShareCardModal()`
- `_dropTriggerCamera()` / `_dropTriggerLibrary()` / `_dropHandlePhoto()` / `_dropChangePhoto()`
  / `_dropShowPhotoStep()` / `_dropRenderReady()` — required-photo gate
- `renderShareCard()` (async) / `_dropLoadImage()` / `_dropSetStyle()` / `_dropWrapText()`
- `generateCaptionBody()` / `generateCaptionFooter()` / `_dropUpdateCounters()`
- `_dropCopyCaption()` / `_dropDownloadImage()` / `_dropNativeShare()`
- `getDropPromptPref()` / `getDropPromptDefault()` / `saveDropPref()` / `_dropGetSellerShowCount()`
- `_dropVenueLabel(showId)` — reads `shows[showId].venue || .city || .location`

### Does not change
`sdConfirm()`'s core sale-recording logic, `recordShowTransaction()`, `recordManualSaleTransaction()`,
`updateReport()`'s stats (only the transaction-log row template gained a Share cell), RLS
policies, no new Supabase tables or Storage buckets.

### Resilience to a not-yet-run `fingerprint`/`detected_confidence` migration
`cardToDbRow()` unconditionally includes `fingerprint`/`detected_confidence` in every
insert/update payload. Before the "Pending DB Migrations" entry for those columns has been
run on a given Supabase project, PostgREST rejects the **entire** write with `400
PGRST204` ("Could not find the 'X' column … in the schema cache") — not just those two
keys — which would otherwise silently break every sale confirmation (sold_price/
payment_method never reach the inventory row) and CSV import, independent of whether Photo
Scan was ever used. `_isMissingScanColumnError(error)` detects this specific error
(`error.code === 'PGRST204'` or a message match), and `insertCardToDB()`, `updateCardInDB()`,
and both write paths inside `upsertCardsToDB()` (batch insert + the per-row update loop)
each strip `fingerprint`/`detected_confidence` from their payload and retry once on that
error. Running the migration removes the need for the retry but the fallback stays cheap
and permanent — no reason to special-case "migration not yet run" as a mode to detect and
warn about.

## Trade Zone

Guest-friendly, phone-first trading board for a live show floor — post a card photo, get
matched, confirm a two-sided trade, generate a branded share graphic. **Fully standalone**
from the rest of the platform: `trade_posts`/`trades`/`traders`/`share_events` never read
or write `inventory`/`shows`/`show_sellers`/`show_inventory`, and none of the functions or
tables documented elsewhere in this file were touched building this.

### Files
`trade-zone.html` (guest quick-post + board + my-trades, mobile-first) · `trade-board.html`
(venue-monitor live board, and `?report=1` for a lightweight organizer report) ·
`js/trade-zone.js` / `js/trade-board.js` / `js/trade-share.js` · `netlify/functions/trade-og.js`
(OG preview + redirect for `/trade/:id`) · `netlify/functions/expire-trade-posts.js` (hourly
scheduled function) · `supabase/migrations/20260825120000_trade_zone.sql` (schema, storage
buckets, RLS, RPC functions — the only place any of this is defined; nothing is duplicated
into JS).

### Naming deviation from the original design doc
The plan's schema names its show-scoping table `shows` (uuid id, `starts_at`/`ends_at`).
The platform already has a production `shows` table (text id, a single `date` column, no
start/end timestamps — see "Database Schema" above) — reusing it would mean changing a
live table's id type or bolting on columns nothing else uses, which conflicts with Trade
Zone's own "standalone" design decision. The migration instead creates **`trade_zone_shows`**
— same columns as the original design, collision-safe name. An organizer sets up a Trade
Zone show separately from a platform Show; the two are unrelated records today.

### Data model (see the migration for the authoritative definition)
`trade_zone_shows` (name, location, starts_at, ends_at) · `traders` (one row per
`auth.users` identity — anonymous or claimed; handle/phone/claimed_at) · `trade_posts`
(one-sided "I have this to trade" — card_name, condition, looking_for, image_url, thumb_url,
status: open/matched/traded/expired) · `trades` (two-sided — post_a/post_b, trader_a/trader_b,
confirmed_a/confirmed_b, confirmed_at, share_consent_a/b, share_image_url) · `share_events`
(append-only log of share/export actions, no reward-eligibility column — deliberately
deferred until an incentive feature is actually scoped). Storage: `trade-zone-cards`
(posts/{post_id}/original.jpg + thumb.jpg) and `trade-zone-shares` (trades/{trade_id}/card.png),
both public-read.

### Guest identity
`supabase.auth.signInAnonymously()` on first load (`tzEnsureGuestSession()` in trade-zone.js)
— gives a real `auth.uid()` for RLS with zero login friction. A `traders` row is upserted for
that identity immediately. **Prerequisite (manual, dashboard-only):** Authentication → Providers
→ Anonymous must be enabled, or `signInAnonymously()` fails at runtime. **Also required:**
Realtime must be on for the project (default) — the migration adds `trade_posts` and `trades`
to the `supabase_realtime` publication itself, wrapped in `DO` blocks so re-running the
migration doesn't error on "already a member".

### RLS + RPC design — why mutations on `trades` go through RPCs, not direct updates
`trade_zone_shows` is public-read/no-client-write. `traders` and `trade_posts` use plain
per-row RLS (`auth.uid() = id` / `auth.uid() = trader_id`) exactly per the original design's
RLS sketch — normal `db.from(...).insert()/.update()` calls from the client work unmodified.

`trades` is different: **it has no client-facing INSERT or UPDATE policy at all.** The
"trader A can never set confirmed_b" and "confirmed_at only flips once both sides have
confirmed" rules are column-granular, and per-column RLS `WITH CHECK` expressions for that
are fragile and hard to verify. Instead every state change goes through a `SECURITY DEFINER`
RPC that does its own explicit authorization check and only ever touches the caller's own
side:
- `propose_trade(post_a_id, post_b_id)` — caller must own post_a; post_b must be a different
  trader's still-open post in the same show; flips both posts to `'matched'`.
- `confirm_trade(trade_id)` — idempotent; sets the caller's own `confirmed_a`/`confirmed_b`;
  once both are true, sets `confirmed_at` and flips both posts to `'traded'` in the same call.
- `set_trade_share_consent(trade_id, consent)` — sets only the caller's own consent flag.
- `set_trade_share_image(trade_id, url)` — only callable by a party to an already-confirmed
  trade, and only for a URL under that trade's own `trades/{trade_id}/` folder in
  `trade-zone-shares` (defense in depth against writing an arbitrary URL into the row).
- `get_trade_partner_handle(trade_id)` — the *only* way a trader's handle ever crosses into
  the other party's client. `traders` RLS stays "own row only" (so `phone` is never
  incidentally exposed by a broader policy); this function returns just the handle string,
  and only when the trade is confirmed and the handle's owner has `share_consent` on.
- `expire_stale_trade_posts()` — `service_role`-only, called from the scheduled Netlify
  function; flips stale `open`/`matched` posts to `'expired'` 1 day after their show's
  `ends_at`. Rows are never deleted.

**All of the above — including the security-critical paths (forged-post-insert rejection,
direct-update rejection, non-party confirm rejection, handle-sharing consent gating, trader
phone-number isolation, and the share-image URL folder guard) — were verified against a real
local Postgres 16 instance with a minimal Supabase-shape stub (`auth.users`/`auth.uid()`,
`storage.buckets`/`objects`, `supabase_realtime` publication) before this shipped, simulating
two anonymous traders via `SET request.jwt.claim.sub`. The migration also re-runs cleanly
(idempotent `DROP POLICY IF EXISTS` + `CREATE POLICY`, `IF NOT EXISTS` tables/indexes,
guarded realtime `ALTER PUBLICATION`).**

### Show resolution (both trade-zone.html and trade-board.html)
`?show=<uuid>` wins if present; otherwise the show currently in progress (`now` between
`starts_at`/`ends_at`); otherwise the soonest upcoming show; otherwise the most recent past
show. `tzResolveShow()` / `tbResolveShow()` — small, deliberately duplicated (not shared)
since the two pages load independently with no build step to share a module from.

### Phase 1 — quick post
Photo capture mirrors the codebase's existing dual-source convention (`capture="environment"`
input for camera, a second plain `accept="image/*"` input for library — same pattern as
Scan-to-Sell POS / Log a Manual Sale). `_tzResizeImageToBlob()` mirrors `_posCompressImage()`'s
canvas-resize convention but returns a `Blob` (for direct Storage `.upload()`) instead of a
base64 string (for a vision API call) — two passes, 1200px/0.8 for the full image and 300px/0.7
for the thumb. The post's `id` is generated client-side (`crypto.randomUUID()`) *before*
upload so both Storage paths and the `trade_posts` insert can reference the same id in one
round trip.

### Phase 2 — live board
`trade-board.html` is a read-only venue-monitor display — no auth, no interaction, large type,
auto-paginates 6 posts at a time every 8s, subscribes to `postgres_changes` on `trade_posts`
(new posts prepend with a highlight pulse) and `trades` (recount on any change). A personal,
interactive version of the board (with a "Propose Trade" button per post) lives in
trade-zone.html's Board tab instead — the plan's "meant for the venue monitor" framing for
`trade-board.html` reads as passive-display-only, so the interactive one is deliberately a
separate surface.

### Phase 3 — trade completion
Propose (from the Board tab) opens a bottom-sheet picker of the caller's own open posts to
offer; confirms via `propose_trade`. Each side confirms independently from the My Trades tab
via `confirm_trade` — the UI shows "Awaiting your confirmation" / "Waiting on the other
trader…" / "✓ Traded" per side. **Known limitation:** there is no decline/cancel-proposal
path in v1 — a proposed-but-never-confirmed trade leaves both posts `'matched'` (unavailable
for other proposals) indefinitely. Not required by the original acceptance criteria; flagged
here as a natural follow-up if it proves to matter in practice.

### Phase 4 — branded share image
`js/trade-share.js`'s `renderShareSlot()` is injected into each confirmed trade's card in the
My Trades tab. Composites a 1080×1920 canvas (gradient background, both cards' full images —
not thumbnails, for quality at that canvas size — swap icon, card names, handles gated by
`get_trade_partner_handle()`, show name, CardShow wordmark watermark — all drawn, no image
assets needed), uploads to `trade-zone-shares`, writes the URL back via `set_trade_share_image`.
Share buttons map to the plan's exact `share_events.platform` enum (`instagram_story`, `x`,
`download`, `copy_link`) — Web Share API's OS share sheet is a black box that never reports
which app the user actually picked, so the button clicked is logged as the platform, matching
how every other app treats "share intent" logging. A spectator who opens a `/trade/:id` link
and isn't a party to that trade gets a read-only rendering (the finished image only, if one
exists) — no consent checkbox or generate button, since those RPCs would just reject them.

### Phase 5 — public link + OG previews
`_redirects` routes `/trade/:id` → `/.netlify/functions/trade-og?id=:id`. `trade-og.js`
checks the request's User-Agent against a known-crawler regex (Facebook/Twitter/Slack/
Discord/WhatsApp/Telegram/LinkedIn/iMessage/etc.); a real human is 302'd straight to
`trade-zone.html?trade=<id>` without touching the DB. A crawler gets server-rendered HTML
with `og:image` set to the trade's `share_image_url` (falls back to a generic
`/og-trade-zone.png` if the trade isn't found or hasn't generated one yet) and `og:title`/
`og:description` naming the show. Uses the anon key only — the `trades` public-select RLS
policy (`confirmed_at is not null`) already covers what this function needs, no service key
required.

### Phase 6 — claim flow + organizer reporting
"Claim your Trade Zone activity" calls `supabase.auth.updateUser({ email, password })` on the
still-anonymous session — Supabase's native anonymous → permanent upgrade converts the
session **in place**, same `auth.uid()`, so every `trade_posts`/`trades` row already tied to
that identity carries over with zero migration (this is *why* anonymous auth was chosen over
a hand-rolled device-token scheme, per the original plan's own rationale). Organizer reporting
is `trade-board.html?report=1` — trade count, confirmed-trade count, `share_events` count for
the show, and a most-traded-cards list (grouped by normalized `card_name` text, since posts
don't carry structured player/set fields — this is a casual free-text flow by design).

### Local testing
```bash
# Apply the migration to a local/dev Supabase project:
supabase db push
# or paste supabase/migrations/20260825120000_trade_zone.sql into the SQL editor.

# Then visit:
#   /trade-zone.html?show=<trade_zone_shows.id>   (guest flow)
#   /trade-board.html?show=<id>                    (venue monitor)
#   /trade-board.html?show=<id>&report=1           (organizer report)
```
The migration seeds one demo `trade_zone_shows` row ("MLP Card Show (Trade Zone demo)") so
both pages have something to resolve to with no `?show=` param on a fresh project.

## Show Configuration (Demo Data)
- **MLP Card Show** — Oct 17-18, 2026 · Grand Hyatt Tampa Bay, FL · Code: MLPTPA (primary demo, shown to buyers without code)
- **Chicago Sports Card Expo** — Nov 8, 2026 · Navy Pier, Chicago, IL · CHI2026
- **NYC Collectors Fair** — Dec 6, 2026 · Javits Center, New York · NYC2026

## Context Maintenance
Update this file at the end of each Claude Code session:
```
Update CLAUDE.md to reflect everything we built today
```
