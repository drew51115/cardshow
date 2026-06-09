# CardShow — Claude Code Context

## Project Overview
CardShow is a sports card show inventory platform connecting buyers, sellers, and show organizers. Built as standalone HTML files, deployed at https://getcardshow.com via Netlify (GitHub auto-deploy).

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework, no npm
- **Backend:** Supabase (postgres) — connected via CDN client in app.html
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
- **Client:** Loaded via CDN in <head> of app.html and seller-browse.html

## Database Schema
```sql
sellers       — id (uuid), handle, display_name, whatsapp, instagram, email, created_at
shows         — id (text), name, date, location, status, access_code, published_at, created_at
show_sellers  — show_id, seller_id, table_number (junction)
inventory     — id (uuid), seller_id, card_title, player, year, card_set, parallel,
                grader, grade, cert_number, condition, price, status, location,
                created_at, updated_at
show_inventory — show_id, card_id (junction)
```

## Supabase Persistence Status
All of the following are wired to Supabase:
- ✅ Inventory — fetch on login, insert (add card), update (edit card + mark sold), upsert (CSV import)
- ✅ Seller profiles — display_name, whatsapp, instagram saved and loaded on login
- ✅ Shows — create, edit, delete (cascades to show_sellers + show_inventory)
- ✅ Show sellers — authorize, remove, table numbers (ascSetTable, setTableNumber, autoAssignTables)
- ✅ Show inventory — publish writes to show_inventory junction table
- ✅ seller-browse.html — fetches live inventory from Supabase on QR scan

## Key Data Structures (in-memory runtime cache)
```js
inventory[]     // master card array — [{Seller, 'Card Title', Player, Year, 'Set ', Price, Status, _dbId, _shows: Set, ...}]
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
- **Seller** — logs in via handle → uploads/manages inventory → profile (display name, WhatsApp, Instagram) → joins shows → QR code for table
- **Admin** — password: admin123 → Shows dashboard (default) → All Inventory tab → create/manage shows, authorize sellers, assign tables, publish, share
- **Buyer** — guest → show picker → browse inventory by sport/search → contact seller via WhatsApp or Instagram

## Auth Status
- **Current:** Handle-based entry (no real auth) — Phase 2 in progress
- **Phase 2 (next):** Replace handle entry with Supabase email + password auth
  - `supabase.auth.signUp()` / `signInWithPassword()`
  - Link seller record to `auth.uid()`
  - Tighten RLS: replace `using (true)` with `using (auth.uid() = seller_id)`
  - `supabase.auth.getSession()` on page load for session persistence
  - Replace hardcoded `admin123` with protected admin account

## Current RLS Policies
All tables use permissive `using (true)` / `with check (true)` policies pre-Phase 2 auth.
Phase 2 will lock down to `auth.uid() = seller_id` / `auth.uid() = id`.

## Key Functions Reference
### Supabase Persistence (app.html)
- `fetchSellerInventoryFromDB(handle)` — loads seller cards on login
- `insertCardToDB(card)` → returns UUID stored as `card._dbId`
- `updateCardInDB(card)` — edit card, mark sold
- `upsertCardsToDB(cards)` — CSV import batch
- `upsertShowToDB(show)` — create/edit show
- `deleteShowFromDB(showId)` — delete show (FK cascades)
- `addShowSellerToDB(showId, handle)` — authorize seller
- `removeShowSellerFromDB(showId, handle)` — deauthorize
- `updateTableNumberInDB(showId, handle, tableNum)` — table assignment
- `publishShowInventoryToDB(showId)` — write show_inventory rows
- `loadShowsFromDB()` — fetch all shows on admin login
- `cardToDbRow(card)` / `dbRowToCard(row)` — field mapping helpers

### Core UI Functions (app.html)
- `loginAsSeller(handle)` / `loginAsAdmin()` / `enterAsBuyer()` / `signOut()`
- `renderAdminShowsDashboard()` — Shows tab full render
- `switchAdminTab('shows'|'inventory')` — admin tab switcher
- `publishSelectedToShow(showId)` — publish all authorized seller cards
- `buildShowPageUrl(showId)` — generates hash-encoded show page URL
- `copyShowPageLink(showId)` — opens share modal with URL
- `saveProfile()` — saves display name, WhatsApp, Instagram to memory + DB
- `saveShow()` / `deleteShow(showId)` — create/delete shows

## Critical Implementation Notes
1. **show.html hash routing** — inventory encoded in URL hash via TextEncoder/TextDecoder. netlify.toml disables pretty URLs to prevent hash stripping on redirect.
2. **sellers Set** — always a `Set`, never an array. Defensive check: `if (!(show.sellers instanceof Set)) show.sellers = new Set(show.sellers || [])` before .has()/.add()
3. **_dbId on cards** — cards get their Supabase UUID stored as `card._dbId` after insert. Required for updateCardInDB and publishShowInventoryToDB.
4. **.maybeSingle() not .single()** — always use maybeSingle() for Supabase queries that might return 0 rows to avoid 406 errors.
5. **No build step** — this is vanilla HTML. No webpack, no npm, no compilation. Edit the HTML files directly.
6. **Domain** — all absolute URLs use getcardshow.com. The old card-show.netlify.app domain is deprecated.

## Backlog Priority
### Tier 1 (immediate)
- Phase 2 email auth (Supabase Auth)
- eBay comp lookup at card entry

### Tier 2
- Barcode/camera scan for card entry
- Card Ladder API integration (partnership outreach needed)
- Quick mark-sold button
- Price refresh before show
- Box/location field per card
- Per-show card selection toggle
- Post-show summary for sellers
- Show page from DB (removes 50-card hash cap)
- Item type support (boxes, packs, lots)

### Tier 3
- Want list / saved cards for buyers
- Dealer-to-dealer transfer
- Stripe billing
- Offer system
- Organizer analytics

### Tier 4
- TCDB card database integration
- Multi-show inventory search for buyers

## Show Configuration (Demo Data)
- **MLP Card Show** — Oct 17-18, 2026 · Grand Hyatt Tampa Bay, FL · Code: MLPTPA (primary demo)
- **Chicago Sports Card Expo** — Nov 8, 2026 · Navy Pier, Chicago, IL · CHI2026
- **NYC Collectors Fair** — Dec 6, 2026 · Javits Center, New York · NYC2026
