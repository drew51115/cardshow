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
index.html          → Landing/marketing page (formerly landing.html)
app.html            → Main platform — seller/admin/buyer views (formerly index.html)
show.html           → Public show page (URL hash-encoded inventory)
seller-browse.html  → Buyer-facing seller storefront (QR scan destination)
_redirects          → Netlify routing rules
netlify.toml        → Disables pretty URLs (critical for show.html hash routing)
CLAUDE.md           → This file
```

## Supabase Configuration
- **Project URL:** https://qtnqawqlmttogwnjieky.supabase.co
- **Anon key:** sb_publishable_R8Yok9YAfb_wfhR5nmwpmg_1FWaCdqU
- **Client:** Loaded via CDN in `<head>` of app.html and seller-browse.html

## Database Schema
```sql
sellers       — id (uuid PRIMARY KEY = auth.uid()), handle, display_name, whatsapp,
                instagram, email, created_at
shows         — id (text), name, date, location, status, access_code, published_at, created_at
show_sellers  — show_id, seller_id (uuid → sellers.id), table_number (junction)
inventory     — id (uuid), seller_id (uuid → sellers.id), card_title, player, year,
                card_set, parallel, grader, grade, cert_number, condition, price,
                status, location, created_at, updated_at
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
- ✅ Phase 2 email auth — Supabase email + password, sessions persist across refreshes

## Auth Status — Phase 2 Deployed
- **Current:** Supabase email + password auth via `supabase.auth.signUp()` / `signInWithPassword()`
- **Session persistence:** `supabase.auth.getSession()` on page load keeps sellers logged in
- **Seller records:** linked to `auth.uid()` in the sellers table
- **⚠ RLS policies:** still using permissive `using (true)` — tightening to `auth.uid() = seller_id` is the next priority
- **⚠ Admin password:** still hardcoded `admin123` — needs replacing with a protected Supabase admin account

## Current RLS Policies (Needs Tightening)
All tables currently use permissive `using (true)` / `with check (true)`.
Next step: replace with `auth.uid() = seller_id` for inventory, `auth.uid() = id` for sellers.

## Key Data Structures (in-memory runtime cache)
```js
inventory[]     // [{Seller, 'Card Title', Player, Year, 'Set ', Price, Status, _dbId, _shows: Set, ...}]
shows{}         // {showId: {id, name, date, location, status, accessCode, sellers: Set, tables: {}, publishedAt}}
sellerProfiles  // {handle: {displayName, whatsapp, instagram}}
currentRole     // 'seller' | 'admin' | 'buyer' | null
currentSeller   // handle string or null
buyerShowId     // active show for buyer view
activeShowId    // active show for admin/seller
```

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
- **Admin** — password: admin123 (⚠ needs replacing) → Shows dashboard (default) → All Inventory tab → create/manage shows, authorize sellers, assign tables, publish, share
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
- `cardToDbRow(card)` / `dbRowToCard(row)` — field mapping helpers

### Auth Functions (app.html)
- `submitAuth()` — async; handles seller sign-in/sign-up and admin sign-in via Supabase Auth
- `toggleAuthMode()` — switches auth overlay between sign-in and sign-up for sellers
- `loginAsSeller(handle)` / `loginAsAdmin()` / `enterAsBuyer()` / `signOut()` (async)

### Core UI Functions (app.html)
- `renderAdminShowsDashboard()` — Shows tab full render
- `switchAdminTab('shows'|'inventory')` — admin tab switcher
- `publishSelectedToShow(showId)` — publish all authorized seller cards
- `buildShowPageUrl(showId)` — generates hash-encoded show page URL
- `copyShowPageLink(showId)` — opens share modal with URL
- `saveProfile()` — saves display name, WhatsApp, Instagram to memory + DB
- `saveShow()` / `deleteShow(showId)` — create/delete shows
- `ascSetTable(showId, handle, input)` — inline table assignment in dashboard
- `setTableNumber(showId, handle, value)` — sidebar table assignment
- `autoAssignTables(showId)` — auto-number all sellers 1–N

## Critical Implementation Notes
1. **show.html hash routing** — inventory encoded in URL hash via TextEncoder/TextDecoder. netlify.toml disables pretty URLs to prevent hash stripping on redirect. Hash must be decoded with TextDecoder, not escape/unescape (deprecated).
2. **sellers Set** — always a `Set`, never an array. Defensive check: `if (!(show.sellers instanceof Set)) show.sellers = new Set(show.sellers || [])` before .has()/.add()
3. **_dbId on cards** — cards get their Supabase UUID stored as `card._dbId` after insert. Required for updateCardInDB and publishShowInventoryToDB.
4. **.maybeSingle() not .single()** — always use maybeSingle() for queries that might return 0 rows. .single() returns 406 on empty result.
5. **No build step** — vanilla HTML only. No webpack, no npm, no compilation. Edit HTML files directly.
6. **Domain** — all absolute URLs use getcardshow.com. The old card-show.netlify.app domain is fully deprecated.
7. **RLS currently permissive** — all policies use `using (true)`. Do not tighten until confirming auth.uid() is reliably set in all write paths.
8. **Seller handle in DB** — inventory rows store seller_id (UUID), not handle. Always look up seller UUID by handle before querying inventory.

## Backlog Priority

### Shipped ✅
- Supabase inventory persistence (read, write, edit, mark sold, CSV import)
- Seller profile persistence (display name, WhatsApp, Instagram)
- Shows persistence layer (create, edit, delete, sellers, table numbers, publish)
- Phase 2 email authentication (Supabase Auth, session persistence)

### Tier 1 — Ship before beta show
- **Tighten RLS policies** (urgent, high complexity) — replace `using (true)` with `auth.uid() = seller_id`
- **eBay comp lookup at card entry** (urgent, medium complexity) — #1 pain point from seller feedback
- **Replace admin123 password** (urgent, low complexity) — security risk now that real auth exists

### Tier 2 — First show retrospective
- Barcode/camera scan for card entry (high complexity) — moved up from Tier 4 based on show feedback
- Card Ladder API integration (high complexity) — partnership outreach needed, no public API
- Quick mark-sold button (low complexity)
- Price refresh before show (medium complexity)
- Box/location field per card (low complexity)
- Per-show card selection toggle (medium complexity)
- Post-show summary for sellers (low complexity)
- Show page from DB — removes 50-card hash cap (high complexity)
- Item type support — boxes, packs, lots (low complexity)

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
