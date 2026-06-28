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
.env.example                      → Placeholder env vars for PSA_API_TOKEN, CGC_API_TOKEN, TCGAPIS_KEY
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
- `switchAdminTab('shows'|'inventory')` — admin tab switcher
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

## Cert Scanner — Sprint 1 Architecture

### Scan Cascade
```
openCertScanner()
  └─ getUserMedia (rear camera)
       ├─ BarcodeDetector API (Chrome/Android, 250ms polling)
       │    └─ handleBarcodeDetected(raw)
       └─ ZXing-js fallback via CDN (iOS Safari, Firefox)
            └─ handleBarcodeDetected(raw)
  
  [3-second timeout] → "Take Photo" button shown
       └─ scanTakePhoto() → Sprint 2 stub (vision AI)

handleBarcodeDetected(raw)
  └─ parseCertBarcode(raw) → { cert, grader }   (PSA 8-9 digits, CGC 10 digits, SGC 7 digits)
       └─ lookupCert(cert, grader)
            └─ POST /.netlify/functions/psa-lookup { cert, grader }
                 └─ fillFormFromScan(card) → pre-fills Add Card form with .scan-filled highlight
```

### Netlify Functions
- **`psa-lookup.js`** — POST `{ cert, grader }` → `{ player, cardSet, year, cardNum, parallel, grade, grader, certNum, sport, rawTitle }`. Routes PSA/SGC to PSA API, CGC to CGC API. Requires `PSA_API_TOKEN` and `CGC_API_TOKEN` env vars set in Netlify dashboard.

### Environment Variables (set in Netlify dashboard)
| Var | Purpose |
|-----|---------|
| `PSA_API_TOKEN` | PSA PublicAPI Bearer token for cert lookups |
| `CGC_API_TOKEN` | CGC API Bearer token for card cert lookups |
| `TCGAPIS_KEY` | Reserved for Sprint 3 TCG price lookups |

### Key Scanner Functions (app.html)
- `openCertScanner()` / `closeCertScanner()` — open/close overlay, start/stop camera
- `startScannerCamera()` — requests getUserMedia, sets 3-second timeout, delegates to native or ZXing
- `startNativeScan()` — BarcodeDetector polling every 250ms
- `startZXingScan()` — loads ZXing from CDN lazily, starts stream decode
- `parseCertBarcode(raw)` — extracts cert + grader from barcode string (digit length heuristic + URL pattern)
- `lookupCert(cert, grader)` — calls psa-lookup function, fills form on success
- `fillFormFromScan(card)` — populates Add Card fields, applies `.scan-filled` yellow highlight for 3s
- `lookupManualCert()` — manual cert + grader entry fallback
- `scanTakePhoto()` — Sprint 2 stub; shows toast, closes scanner

### Sprint 2 Plan
Replace `scanTakePhoto()` stub: capture canvas frame from video element → POST to a new `netlify/functions/vision-lookup.js` → call Claude Vision API → parse card details → fill form.

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

### Tier 1 — Ship before beta show
- **Tighten RLS policies** (urgent, high complexity) — replace `using (true)` with `auth.uid() = seller_id`
- **eBay comp lookup at card entry** (urgent, medium complexity) — #1 pain point from seller feedback

### Tier 2 — First show retrospective
- Barcode/camera scan for card entry (high complexity) — moved up from Tier 4 based on show feedback
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
