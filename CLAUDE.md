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
netlify/functions/trading-card-lookup.js → Serverless: POST {query, sport?} → card search results from Trading Card API (Sprint 3); write-through cache via card_search_cache table (7-day TTL)
netlify/functions/invalidate-search-cache.js → Serverless: POST {query} → deletes matching rows from card_search_cache; protected by x-invalidate-secret header
.env.example                             → Placeholder env vars for all keys
downloads/                               → Static file downloads served by Netlify
downloads/CardShow_Inventory_Template.xlsx → Pre-filled inventory template (13 example rows); linked from landing page and footer
downloads/.gitkeep                       → Tracks empty directory in git
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
shows         — id (text), name, date, location, status, access_code, published_at, created_at
show_sellers  — show_id, seller_id (uuid → sellers.id), table_number (junction)
inventory     — id (uuid), seller_id (uuid → sellers.id), card_title, player, year,
                card_set, parallel, grader, grade, cert_number, condition, price,
                status, location, item_type, product_type, created_at, updated_at
show_inventory — show_id, card_id (junction)
admins        — id (uuid PRIMARY KEY REFERENCES auth.users) — admin identity gate
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
26. **FAB (`#fabAddCard`) is seller-only** — Shown via `style.display=''` in `loginAsSeller()`, hidden in `loginAsAdmin()` and `signOut()`. Only visible at `≤767px` via CSS. Black background + gold border + gold "+" text for maximum contrast against dark UI.
27. **Comp search includes parallel** — `comp-lookup.js` search query: `[player, year, cardSet, parallel].filter(Boolean).join(' ')`. Cache fingerprint: `player|year|cardSet|cardNumber|parallel|grade|grader`. Both changes ensure autos/variants get correct prices instead of base card prices.

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
| `CARDSIGHT_API_KEY` | CardSight AI key — primary sports card comp source. Free tier: 750 calls/month. cardsight.ai/for-developers |

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

## Comp Pricing — CardSight AI + PriceCharting + TCG API

### Architecture
- `netlify/functions/comp-lookup.js` — POST `{ cards: [...] }` → `{ results: [...] }`
- Cards processed **sequentially** (for...of, never Promise.all) to respect PriceCharting's 1 req/s limit
- Sport routing:
  - Pokemon → pokemontcg.io (TCGPlayer market prices), fallback to TCG API
  - Other TCG (MTG, Yu-Gi-Oh, etc.) → TCG API
  - Sports cards → **CardSight AI** (primary), fallback to PriceCharting

### CardSight AI — Primary Sports Card Comp Source
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
- `extractReleaseName(cardSet)` maps set name to CardSight's `releaseName` keyword (40-entry signature table; **order matters** — more specific variants listed first, e.g. "Topps Chrome Update" before "Topps Chrome", "Bowman Chrome Draft" before "Bowman Chrome"). Falls back to first long word.
- `deriveAttributeShortNames(card)` maps cardTitle/parallel to RC/AU codes; AU returned first (more pricing-specific).
- `scoreCatalogMatch()` is now a tiebreaker — results already pre-filtered by year/release/attr. Fast path on exact number match; then scores solo card (+20), player in name (+10), partial number (+8). No minimum threshold.
- **Exact number tie-break**: when `number=` returns multiple cards sharing the same number across different releases (e.g. Bowman Sterling + Topps Chrome + Triple Threads all sharing "RA-PS"), each is scored by `releaseName` word overlap against the seller's set. The highest-scoring release wins; first result is the safe default.
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
- Default for unrecognized: `'Baseball'` (routes to CardSight → PriceCharting fallback)

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
- Organizer analytics dashboard

### Tier 4 — Long game
- TCDB card database integration (3M+ card autocomplete)
- Multi-show inventory search for buyers (requires show page from DB first)

### Immediate actions outside the platform
- Beta test at organizer's next show — respond with concrete proposal
- Card Ladder partnership outreach — co-marketing deal for comp data access

## Show Configuration (Demo Data)
- **MLP Card Show** — Oct 17-18, 2026 · Grand Hyatt Tampa Bay, FL · Code: MLPTPA (primary demo, shown to buyers without code)
- **Chicago Sports Card Expo** — Nov 8, 2026 · Navy Pier, Chicago, IL · CHI2026
- **NYC Collectors Fair** — Dec 6, 2026 · Javits Center, New York · NYC2026

## Context Maintenance
Update this file at the end of each Claude Code session:
```
Update CLAUDE.md to reflect everything we built today
```
