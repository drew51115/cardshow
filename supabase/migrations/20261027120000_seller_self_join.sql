-- Seller self-join: a seller adds themselves to a show they're vending at,
-- instead of waiting for the organizer to authorize them.
--
--   show_sellers.self_joined  true when the seller added themselves (the
--                             organizer sees a "joined themselves" tag)
--   show_sellers.joined_at    when the row was created
--   shows.seller_self_join    organizer switch, on by default; off means only
--                             the organizer can add sellers to that show
--
-- Joining and leaving go through two SECURITY DEFINER functions so the rules
-- live on the server: join_show_as_seller() and leave_show_as_seller().
-- Safe to run more than once.

alter table public.show_sellers
  add column if not exists self_joined boolean not null default false,
  add column if not exists joined_at   timestamptz default now();

alter table public.shows
  add column if not exists seller_self_join boolean not null default true;

-- Last day of the show, from end_date, else start_date. Read through jsonb so
-- this still works on a project that hasn't added those columns yet.
create or replace function public._show_last_day(s public.shows)
returns date language sql stable as $$
  select coalesce(
    nullif(to_jsonb(s)->>'end_date', '')::date,
    nullif(to_jsonb(s)->>'start_date', '')::date)
$$;

-- Adds the signed-in seller to a show.
-- Returns { ok: true, already: bool } or { error: 'not_signed_in' | 'no_seller'
-- | 'not_found' | 'closed' | 'ended' }.
create or replace function public.join_show_as_seller(p_show_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_show public.shows;
  v_last date;
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

  if v_show.seller_self_join is false then return jsonb_build_object('error', 'closed'); end if;

  -- One day of grace: the server clock is UTC, and a show's last evening in
  -- the US is already the next day there.
  v_last := public._show_last_day(v_show);
  if v_last is not null and v_last < current_date - 1 then
    return jsonb_build_object('error', 'ended');
  end if;
  if v_last is null and coalesce(to_jsonb(v_show)->>'status', '') = 'past' then
    return jsonb_build_object('error', 'ended');
  end if;

  insert into public.show_sellers (show_id, seller_id, self_joined, joined_at)
  values (p_show_id, v_uid, true, now());
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- Removes the signed-in seller from a show they joined themselves, and takes
-- their cards off it. A seller the organizer added can't leave this way.
-- Returns { ok: true, cards_removed: n } or { error: 'not_signed_in' |
-- 'not_joined' | 'organizer_added' }.
create or replace function public.leave_show_as_seller(p_show_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_self  boolean;
  v_cards int;
begin
  if v_uid is null then return jsonb_build_object('error', 'not_signed_in'); end if;
  select self_joined into v_self from public.show_sellers
   where show_id = p_show_id and seller_id = v_uid limit 1;
  if not found then return jsonb_build_object('error', 'not_joined'); end if;
  if v_self is not true then return jsonb_build_object('error', 'organizer_added'); end if;

  delete from public.show_inventory si
   using public.inventory i
   where si.show_id = p_show_id and si.card_id = i.id and i.seller_id = v_uid;
  get diagnostics v_cards = row_count;

  delete from public.show_sellers where show_id = p_show_id and seller_id = v_uid;
  return jsonb_build_object('ok', true, 'cards_removed', v_cards);
end $$;

revoke all on function public.join_show_as_seller(text)  from public;
revoke all on function public.leave_show_as_seller(text) from public;
grant execute on function public.join_show_as_seller(text)  to authenticated;
grant execute on function public.leave_show_as_seller(text) to authenticated;
