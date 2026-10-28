-- Show directory: the platform owner curates which shows sellers can join.
-- Run after 20261027120000_seller_self_join.sql. Safe to run more than once.
--
--   shows.listed            only listed shows appear in a seller's "Join a show"
--                           list, and join_show_as_seller() refuses the rest
--   shows.slug              short unique id per show edition, e.g. monster-show-2026-10
--   shows.timezone          IANA zone, so "has this show ended" uses the show's own date
--   shows.website           optional
--   shows.merged_into       set when a duplicate was merged into another show
--   platform_admins         who can list shows (add your auth user id by hand, below)
--   show_requests           sellers ask for a show that isn't listed yet
--
-- After running, make yourself the platform owner:
--   insert into public.platform_admins (id) values ('<your auth.users id>');

alter table public.shows
  add column if not exists listed      boolean not null default false,
  add column if not exists listed_at   timestamptz,
  add column if not exists listed_by   uuid,
  add column if not exists slug        text,
  add column if not exists timezone    text,
  add column if not exists website     text,
  add column if not exists merged_into text;

create unique index if not exists shows_slug_key on public.shows (slug) where slug is not null;
create index if not exists shows_listed_idx on public.shows (listed) where listed;

create table if not exists public.platform_admins (
  id         uuid primary key,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
drop policy if exists platform_admins_read_own on public.platform_admins;
create policy platform_admins_read_own on public.platform_admins
  for select using (id = auth.uid());

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where id = auth.uid())
$$;

create table if not exists public.show_requests (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null,
  name        text not null,
  start_date  date not null,
  end_date    date,
  venue       text,
  city        text,
  state       text,
  website     text,
  notes       text,
  status      text not null default 'pending' check (status in ('pending', 'listed', 'declined')),
  show_id     text,
  review_note text,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);
create index if not exists show_requests_status_idx on public.show_requests (status, created_at);
alter table public.show_requests enable row level security;
-- Sellers see their own requests; the platform owner sees all. No client writes:
-- requests go through submit_show_request() / resolve_show_request().
drop policy if exists show_requests_read on public.show_requests;
create policy show_requests_read on public.show_requests
  for select using (seller_id = auth.uid() or public.is_platform_admin());

-- "monster-show-2026-10" from name + start date; numbered if taken.
create or replace function public._show_slug(p_name text, p_start date, p_self text)
returns text language plpgsql stable set search_path = public as $$
declare
  v_base text := trim(both '-' from regexp_replace(lower(coalesce(p_name, 'show')), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
  n int := 1;
begin
  if v_base = '' then v_base := 'show'; end if;
  v_base := left(v_base, 60) || coalesce('-' || to_char(p_start, 'YYYY-MM'), '');
  v_slug := v_base;
  while exists (select 1 from public.shows where slug = v_slug and id <> p_self) loop
    n := n + 1;
    v_slug := v_base || '-' || n;
  end loop;
  return v_slug;
end $$;

-- Lists or unlists a show. Listing needs the structured fields filled in.
-- Returns { ok, slug } or { error: 'forbidden' | 'not_found' | 'missing_fields', fields }.
create or replace function public.set_show_listed(p_show_id text, p_listed boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_show    public.shows;
  v_missing text[] := '{}';
  v_slug    text;
begin
  if not public.is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into v_show from public.shows where id = p_show_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  if not p_listed then
    update public.shows set listed = false where id = p_show_id;
    return jsonb_build_object('ok', true, 'listed', false);
  end if;

  if coalesce(trim(v_show.name), '') = '' then v_missing := array_append(v_missing, 'name'); end if;
  if v_show.start_date is null then v_missing := array_append(v_missing, 'start_date'); end if;
  if coalesce(trim(v_show.venue), '') = '' then v_missing := array_append(v_missing, 'venue'); end if;
  if coalesce(trim(v_show.city), '') = '' then v_missing := array_append(v_missing, 'city'); end if;
  if coalesce(v_show.state, '') !~ '^[A-Z]{2}$' then v_missing := array_append(v_missing, 'state'); end if;
  if v_show.merged_into is not null then v_missing := array_append(v_missing, 'merged'); end if;
  if array_length(v_missing, 1) > 0 then
    return jsonb_build_object('error', 'missing_fields', 'fields', to_jsonb(v_missing));
  end if;

  v_slug := coalesce(v_show.slug, public._show_slug(v_show.name, v_show.start_date, v_show.id));
  update public.shows
     set listed = true, listed_at = now(), listed_by = auth.uid(), slug = v_slug
   where id = p_show_id;
  return jsonb_build_object('ok', true, 'listed', true, 'slug', v_slug);
end $$;

-- A seller asks for a show to be added. At most 10 pending per seller; the
-- same name + start date twice returns the existing request.
create or replace function public.submit_show_request(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := nullif(trim(p->>'name'), '');
  v_start date;
  v_id    uuid;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if not exists (select 1 from public.sellers where id = v_uid) then
    return jsonb_build_object('error', 'no_seller');
  end if;
  begin v_start := nullif(p->>'start_date', '')::date;
  exception when others then v_start := null; end;
  if v_name is null or v_start is null then return jsonb_build_object('error', 'missing_fields'); end if;

  select id into v_id from public.show_requests
   where seller_id = v_uid and status = 'pending' and lower(name) = lower(v_name) and start_date = v_start;
  if found then return jsonb_build_object('ok', true, 'id', v_id, 'already', true); end if;

  if (select count(*) from public.show_requests where seller_id = v_uid and status = 'pending') >= 10 then
    return jsonb_build_object('error', 'too_many');
  end if;

  insert into public.show_requests (seller_id, name, start_date, end_date, venue, city, state, website, notes)
  values (v_uid, left(v_name, 120), v_start,
          nullif(p->>'end_date', '')::date,
          left(nullif(trim(p->>'venue'), ''), 120),
          left(nullif(trim(p->>'city'), ''), 80),
          upper(left(nullif(trim(p->>'state'), ''), 2)),
          left(nullif(trim(p->>'website'), ''), 300),
          left(nullif(trim(p->>'notes'), ''), 1000))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'already', false);
end $$;

-- Platform owner closes a request: 'listed' links it to a show (which must be
-- listed) and adds the requesting seller to it; 'declined' just closes it.
create or replace function public.resolve_show_request(p_request_id uuid, p_action text, p_show_id text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_req public.show_requests;
begin
  if not public.is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into v_req from public.show_requests where id = p_request_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if p_action not in ('listed', 'declined') then return jsonb_build_object('error', 'bad_action'); end if;

  if p_action = 'listed' then
    if not exists (select 1 from public.shows where id = p_show_id and listed) then
      return jsonb_build_object('error', 'show_not_listed');
    end if;
    if not exists (select 1 from public.show_sellers where show_id = p_show_id and seller_id = v_req.seller_id) then
      insert into public.show_sellers (show_id, seller_id, self_joined, joined_at)
      values (p_show_id, v_req.seller_id, true, now());
    end if;
  end if;

  update public.show_requests
     set status = p_action, show_id = case when p_action = 'listed' then p_show_id end,
         review_note = nullif(trim(p_note), ''), reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_request_id;
  return jsonb_build_object('ok', true);
end $$;

-- Merges a duplicate into the show to keep: moves sellers (keeping table
-- numbers) and published cards, then unlists the duplicate and closes it to
-- self-join. The duplicate row stays because show_floor_transactions points at
-- it and that table is immutable.
create or replace function public.merge_shows(p_from text, p_into text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sellers int;
  v_cards   int;
begin
  if not public.is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if p_from = p_into then return jsonb_build_object('error', 'same_show'); end if;
  if not exists (select 1 from public.shows where id = p_from)
     or not exists (select 1 from public.shows where id = p_into) then
    return jsonb_build_object('error', 'not_found');
  end if;

  insert into public.show_sellers (show_id, seller_id, table_number, self_joined, joined_at)
  select p_into, f.seller_id, f.table_number, f.self_joined, f.joined_at
    from public.show_sellers f
   where f.show_id = p_from
     and not exists (select 1 from public.show_sellers t where t.show_id = p_into and t.seller_id = f.seller_id);
  get diagnostics v_sellers = row_count;

  insert into public.show_inventory (show_id, card_id)
  select p_into, card_id from public.show_inventory where show_id = p_from
  on conflict do nothing;
  get diagnostics v_cards = row_count;

  delete from public.show_inventory where show_id = p_from;
  delete from public.show_sellers where show_id = p_from;
  update public.show_requests set show_id = p_into where show_id = p_from;
  update public.shows set listed = false, seller_self_join = false, merged_into = p_into where id = p_from;
  return jsonb_build_object('ok', true, 'sellers_moved', v_sellers, 'cards_moved', v_cards);
end $$;

-- join_show_as_seller(), now also requiring a listed show, and using the
-- show's own time zone for "has it ended" when one is set.
create or replace function public.join_show_as_seller(p_show_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_show  public.shows;
  v_last  date;
  v_today date;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  if not exists (select 1 from public.sellers where id = v_uid) then
    return jsonb_build_object('error', 'no_seller');
  end if;

  select * into v_show from public.shows where id = p_show_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  if exists (select 1 from public.show_sellers where show_id = p_show_id and seller_id = v_uid) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if v_show.listed is not true then return jsonb_build_object('error', 'not_listed'); end if;
  if v_show.seller_self_join is false then return jsonb_build_object('error', 'closed'); end if;

  v_last := public._show_last_day(v_show);
  if v_show.timezone is not null and exists (select 1 from pg_timezone_names where name = v_show.timezone) then
    v_today := (now() at time zone v_show.timezone)::date;
  else
    v_today := current_date - 1;   -- UTC clock: one day of grace
  end if;
  if v_last is not null and v_last < v_today then
    return jsonb_build_object('error', 'ended');
  end if;
  if v_last is null and coalesce(v_show.status, '') = 'past' then
    return jsonb_build_object('error', 'ended');
  end if;

  insert into public.show_sellers (show_id, seller_id, self_joined, joined_at)
  values (p_show_id, v_uid, true, now());
  return jsonb_build_object('ok', true, 'already', false);
end $$;

grant select on public.platform_admins to authenticated;
grant select on public.show_requests  to authenticated;

revoke all on function public.is_platform_admin()                         from public;
revoke all on function public.set_show_listed(text, boolean)              from public;
revoke all on function public.submit_show_request(jsonb)                  from public;
revoke all on function public.resolve_show_request(uuid, text, text, text) from public;
revoke all on function public.merge_shows(text, text)                     from public;
revoke all on function public.join_show_as_seller(text)                   from public;
grant execute on function public.is_platform_admin()                         to authenticated;
grant execute on function public.set_show_listed(text, boolean)              to authenticated;
grant execute on function public.submit_show_request(jsonb)                  to authenticated;
grant execute on function public.resolve_show_request(uuid, text, text, text) to authenticated;
grant execute on function public.merge_shows(text, text)                     to authenticated;
grant execute on function public.join_show_as_seller(text)                   to authenticated;
