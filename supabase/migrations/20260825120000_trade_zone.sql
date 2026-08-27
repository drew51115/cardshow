-- ══════════════════════════════════════════════════════════════════
-- Trade Zone — schema, storage buckets, RLS, and RPC functions
-- ══════════════════════════════════════════════════════════════════
-- Trade Zone is a lightweight, standalone feature for guest-friendly
-- show-floor trading. It intentionally never reads or writes the core
-- inventory tables (inventory, shows, show_sellers, show_inventory).
--
-- NAMING NOTE: the original Trade Zone design doc calls its show-scoping
-- table "shows" with a uuid id and starts_at/ends_at columns. The
-- CardShow platform already has a production `shows` table (text id,
-- single `date` column, no starts_at/ends_at — see CLAUDE.md). Reusing
-- that table would require either changing its id type or adding new
-- columns to a live, in-use table, and Trade Zone is deliberately meant
-- to stay standalone. This migration instead creates `trade_zone_shows`
-- as its own show registry — same columns as the original design, just
-- a collision-safe name. Organizers create a Trade Zone show separately
-- from a platform Show; nothing here reads from or writes to `shows`.
--
-- Run this whole file in the Supabase SQL editor (or via the CLI:
-- `supabase db push`). Requires the pgcrypto/pgsodium gen_random_uuid()
-- function, already available by default on Supabase projects.
--
-- PREREQUISITE (manual, dashboard-only): enable Anonymous Sign-Ins under
-- Authentication → Providers → Anonymous. Guest identity for Trade Zone
-- depends on supabase.auth.signInAnonymously() succeeding.
-- ══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- TABLES
-- ──────────────────────────────────────────────────────────────────

create table if not exists trade_zone_shows (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  location   text,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz default now()
);

-- One row per anonymous (or claimed) auth identity.
create table if not exists traders (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text,
  phone        text,
  claimed_at   timestamptz,
  created_at   timestamptz default now()
);

create table if not exists trade_posts (
  id           uuid primary key default gen_random_uuid(),
  show_id      uuid references trade_zone_shows(id) not null,
  trader_id    uuid references traders(id) not null,
  card_name    text not null,
  condition    text,
  looking_for  text,
  image_url    text not null,
  thumb_url    text not null,
  status       text not null default 'open'
                 check (status in ('open','matched','traded','expired')),
  created_at   timestamptz default now()
);

create index if not exists trade_posts_show_status_idx
  on trade_posts (show_id, status, created_at desc);

create table if not exists trades (
  id                 uuid primary key default gen_random_uuid(),
  show_id            uuid references trade_zone_shows(id) not null,
  post_a_id          uuid references trade_posts(id) not null,
  post_b_id          uuid references trade_posts(id) not null,
  trader_a_id        uuid references traders(id) not null,
  trader_b_id        uuid references traders(id) not null,
  confirmed_a        boolean default false,
  confirmed_b        boolean default false,
  confirmed_at       timestamptz,
  share_consent_a    boolean default false,
  share_consent_b    boolean default false,
  share_image_url    text,
  created_at         timestamptz default now(),
  constraint trades_distinct_posts check (post_a_id <> post_b_id),
  constraint trades_distinct_traders check (trader_a_id <> trader_b_id)
);

create index if not exists trades_show_idx on trades (show_id);

-- Append-only log of share/export actions, for organizer reporting.
-- No reward/raffle-eligibility flag — deliberately deferred, see plan §3 Phase 4.
create table if not exists share_events (
  id         uuid primary key default gen_random_uuid(),
  trade_id   uuid references trades(id) not null,
  platform   text not null
               check (platform in ('instagram_story','x','download','copy_link')),
  created_at timestamptz default now()
);

create index if not exists share_events_trade_idx on share_events (trade_id);

-- ──────────────────────────────────────────────────────────────────
-- STORAGE BUCKETS
-- ──────────────────────────────────────────────────────────────────
-- trade-zone-cards  → posts/{post_id}/original.jpg, posts/{post_id}/thumb.jpg
-- trade-zone-shares → trades/{trade_id}/card.png (generated branded graphic)
-- Both public-read (needed for the board, social previews, and OG images).

insert into storage.buckets (id, name, public)
values ('trade-zone-cards', 'trade-zone-cards', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('trade-zone-shares', 'trade-zone-shares', true)
on conflict (id) do nothing;

-- Public read (defensive — public buckets already serve objects without
-- this, but an explicit policy keeps dashboard-based access consistent).
drop policy if exists "trade_zone_cards_public_read" on storage.objects;
create policy "trade_zone_cards_public_read"
  on storage.objects for select
  using (bucket_id = 'trade-zone-cards');

drop policy if exists "trade_zone_shares_public_read" on storage.objects;
create policy "trade_zone_shares_public_read"
  on storage.objects for select
  using (bucket_id = 'trade-zone-shares');

-- Any authenticated identity (anonymous auth users included — Supabase
-- anonymous sessions carry role 'authenticated' with an is_anonymous
-- claim) may upload into either bucket. This is intentionally permissive
-- rather than tying uploads to a specific post/trade id in the path —
-- matches this codebase's existing "permissive now, tighten later"
-- posture for RLS (see CLAUDE.md "Current RLS Policies" note). Junk
-- uploads with no matching trade_posts/trades row have no display
-- surface and are low-value abuse only.
drop policy if exists "trade_zone_cards_authenticated_insert" on storage.objects;
create policy "trade_zone_cards_authenticated_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'trade-zone-cards');

drop policy if exists "trade_zone_shares_authenticated_insert" on storage.objects;
create policy "trade_zone_shares_authenticated_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'trade-zone-shares');

-- ──────────────────────────────────────────────────────────────────
-- REALTIME
-- ──────────────────────────────────────────────────────────────────
-- trade-board.html and trade-zone.js both subscribe to postgres_changes
-- on these tables. Supabase only broadcasts tables that are members of
-- the `supabase_realtime` publication — wrapped in DO blocks so re-running
-- this migration doesn't error on "already a member".

do $$
begin
  alter publication supabase_realtime add table trade_posts;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table trades;
exception when duplicate_object then null;
end $$;

-- ──────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────────

alter table trade_zone_shows enable row level security;
alter table traders           enable row level security;
alter table trade_posts       enable row level security;
alter table trades            enable row level security;
alter table share_events      enable row level security;

-- trade_zone_shows: public read (needed to render show name/location on
-- the guest-facing pages before they've signed in), no client writes —
-- shows are seeded by migration/organizer tooling, not the app.
drop policy if exists "trade_zone_shows_public_read" on trade_zone_shows;
create policy "trade_zone_shows_public_read"
  on trade_zone_shows for select
  using (true);

-- traders: a user can only read/update their own row (per plan §1 RLS
-- sketch). Handle sharing on the branded share image is handled by the
-- get_trade_partner_handle() RPC below, not by widening this policy —
-- that keeps `phone` off any row a peer trader could otherwise select.
drop policy if exists "traders_select_own" on traders;
create policy "traders_select_own"
  on traders for select
  using (id = auth.uid());

drop policy if exists "traders_insert_own" on traders;
create policy "traders_insert_own"
  on traders for insert
  with check (id = auth.uid());

drop policy if exists "traders_update_own" on traders;
create policy "traders_update_own"
  on traders for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- trade_posts: insert/update only your own post; select any non-expired
-- post (the public board), scoped to a show client-side via the query.
drop policy if exists "trade_posts_select_active" on trade_posts;
create policy "trade_posts_select_active"
  on trade_posts for select
  using (status <> 'expired');

drop policy if exists "trade_posts_insert_own" on trade_posts;
create policy "trade_posts_insert_own"
  on trade_posts for insert
  with check (trader_id = auth.uid());

drop policy if exists "trade_posts_update_own" on trade_posts;
create policy "trade_posts_update_own"
  on trade_posts for update
  using (trader_id = auth.uid())
  with check (trader_id = auth.uid());

-- trades: no direct client insert/update policies at all. Every mutation
-- (propose, confirm, consent, share-image write) goes through a
-- SECURITY DEFINER RPC below so that column-level rules — "trader A can
-- never set confirmed_b", "confirmed_at only flips when both sides have
-- confirmed" — are enforced centrally instead of via fragile per-column
-- RLS expressions. Select is public once confirmed (needed by the OG
-- preview function), or visible to either party beforehand so they can
-- see "waiting on the other trader".
drop policy if exists "trades_select_own_or_confirmed" on trades;
create policy "trades_select_own_or_confirmed"
  on trades for select
  using (confirmed_at is not null or auth.uid() in (trader_a_id, trader_b_id));

-- share_events: either party to the underlying trade may log a share
-- action; anyone may read counts (organizer reporting has no separate
-- admin auth in Trade Zone — matches this table's "log, not secret" role).
drop policy if exists "share_events_select_all" on share_events;
create policy "share_events_select_all"
  on share_events for select
  using (true);

drop policy if exists "share_events_insert_party" on share_events;
create policy "share_events_insert_party"
  on share_events for insert
  with check (
    exists (
      select 1 from trades t
      where t.id = share_events.trade_id
        and auth.uid() in (t.trader_a_id, t.trader_b_id)
    )
  );

-- ──────────────────────────────────────────────────────────────────
-- RPC FUNCTIONS (all SECURITY DEFINER — table owner bypasses RLS,
-- each function does its own explicit authorization check instead)
-- ──────────────────────────────────────────────────────────────────

-- Propose a trade: caller must own post_a; post_b must belong to a
-- different trader in the same show and still be open.
create or replace function propose_trade(p_post_a_id uuid, p_post_b_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post_a trade_posts;
  v_post_b trade_posts;
  v_trade_id uuid;
begin
  select * into v_post_a from trade_posts where id = p_post_a_id;
  select * into v_post_b from trade_posts where id = p_post_b_id;

  if v_post_a.id is null or v_post_b.id is null then
    raise exception 'post not found';
  end if;
  if v_post_a.trader_id <> auth.uid() then
    raise exception 'you do not own post_a';
  end if;
  if v_post_b.trader_id = auth.uid() then
    raise exception 'cannot propose a trade with yourself';
  end if;
  if v_post_a.show_id <> v_post_b.show_id then
    raise exception 'posts must belong to the same show';
  end if;
  if v_post_a.status <> 'open' or v_post_b.status <> 'open' then
    raise exception 'both posts must be open';
  end if;

  insert into trades (show_id, post_a_id, post_b_id, trader_a_id, trader_b_id)
  values (v_post_a.show_id, p_post_a_id, p_post_b_id, auth.uid(), v_post_b.trader_id)
  returning id into v_trade_id;

  update trade_posts set status = 'matched' where id in (p_post_a_id, p_post_b_id);

  return v_trade_id;
end;
$$;

-- Confirm your side of a trade. Idempotent. Flips confirmed_at + both
-- posts to 'traded' the moment both sides have confirmed.
create or replace function confirm_trade(p_trade_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades;
begin
  select * into v_trade from trades where id = p_trade_id;
  if v_trade.id is null then
    raise exception 'trade not found';
  end if;
  if auth.uid() not in (v_trade.trader_a_id, v_trade.trader_b_id) then
    raise exception 'not a party to this trade';
  end if;

  if auth.uid() = v_trade.trader_a_id then
    update trades set confirmed_a = true where id = p_trade_id;
  else
    update trades set confirmed_b = true where id = p_trade_id;
  end if;

  select * into v_trade from trades where id = p_trade_id;

  if v_trade.confirmed_a and v_trade.confirmed_b and v_trade.confirmed_at is null then
    update trades set confirmed_at = now() where id = p_trade_id;
    update trade_posts set status = 'traded' where id in (v_trade.post_a_id, v_trade.post_b_id);
    select * into v_trade from trades where id = p_trade_id;
  end if;

  return jsonb_build_object(
    'confirmed_a', v_trade.confirmed_a,
    'confirmed_b', v_trade.confirmed_b,
    'confirmed_at', v_trade.confirmed_at
  );
end;
$$;

-- Set your own share consent flag (never the other party's).
create or replace function set_trade_share_consent(p_trade_id uuid, p_consent boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades;
begin
  select * into v_trade from trades where id = p_trade_id;
  if v_trade.id is null then
    raise exception 'trade not found';
  end if;

  if auth.uid() = v_trade.trader_a_id then
    update trades set share_consent_a = p_consent where id = p_trade_id;
  elsif auth.uid() = v_trade.trader_b_id then
    update trades set share_consent_b = p_consent where id = p_trade_id;
  else
    raise exception 'not a party to this trade';
  end if;
end;
$$;

-- Record the generated branded share image URL. Only callable by a
-- party to an already-confirmed trade, and only for a path under this
-- trade's own folder in the trade-zone-shares bucket.
create or replace function set_trade_share_image(p_trade_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades;
begin
  select * into v_trade from trades where id = p_trade_id;
  if v_trade.id is null or v_trade.confirmed_at is null then
    raise exception 'trade not found or not confirmed';
  end if;
  if auth.uid() not in (v_trade.trader_a_id, v_trade.trader_b_id) then
    raise exception 'not a party to this trade';
  end if;
  if p_url not like ('%trade-zone-shares/trades/' || p_trade_id::text || '/%') then
    raise exception 'url must point at this trade''s own share folder';
  end if;

  update trades set share_image_url = p_url where id = p_trade_id;
end;
$$;

-- Returns the other trader's handle for a confirmed trade, but only if
-- that trader has opted in via share_consent. Never exposes phone or
-- any other traders column. This is the only way handles cross from one
-- trader's row into the other trader's client — the base RLS policy on
-- `traders` stays "own row only".
create or replace function get_trade_partner_handle(p_trade_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handle text;
begin
  select
    case
      when t.trader_a_id = auth.uid() and t.share_consent_b then tb.handle
      when t.trader_b_id = auth.uid() and t.share_consent_a then ta.handle
      else null
    end
  into v_handle
  from trades t
  join traders ta on ta.id = t.trader_a_id
  join traders tb on tb.id = t.trader_b_id
  where t.id = p_trade_id
    and t.confirmed_at is not null
    and auth.uid() in (t.trader_a_id, t.trader_b_id);

  return v_handle;
end;
$$;

-- Scheduled maintenance: expire stale open/matched posts 1 day after
-- their show's ends_at. Rows are never deleted. service_role only —
-- called from netlify/functions/expire-trade-posts.js on a cron.
create or replace function expire_stale_trade_posts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update trade_posts tp
  set status = 'expired'
  from trade_zone_shows s
  where tp.show_id = s.id
    and tp.status in ('open','matched')
    and s.ends_at < (now() - interval '1 day');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function expire_stale_trade_posts() from public;
grant execute on function expire_stale_trade_posts() to service_role;

grant execute on function propose_trade(uuid, uuid)            to authenticated;
grant execute on function confirm_trade(uuid)                   to authenticated;
grant execute on function set_trade_share_consent(uuid, boolean) to authenticated;
grant execute on function set_trade_share_image(uuid, text)     to authenticated;
grant execute on function get_trade_partner_handle(uuid)         to authenticated;

-- ──────────────────────────────────────────────────────────────────
-- SEED — one Trade Zone show for local/dev testing (Phase 0 acceptance).
-- Matches the platform's existing "MLP Card Show" demo dates loosely;
-- safe to delete/edit in the dashboard for real events.
-- ──────────────────────────────────────────────────────────────────
insert into trade_zone_shows (name, location, starts_at, ends_at)
select 'MLP Card Show (Trade Zone demo)', 'Grand Hyatt Tampa Bay, FL',
       '2026-10-17T09:00:00-04:00', '2026-10-18T17:00:00-04:00'
where not exists (select 1 from trade_zone_shows where name = 'MLP Card Show (Trade Zone demo)');
