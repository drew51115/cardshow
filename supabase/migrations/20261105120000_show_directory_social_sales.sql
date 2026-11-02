-- Show Directory + Social Sales: keep social sale data with its show.
-- Run after 20261028120000_show_directory.sql, 20261031120000_delete_show.sql
-- and the social sales migrations (20261012120000/20261012140000). Safe to run
-- more than once, and on a project without the social sales tables.
--
-- social_sales, social_extractions and social_posts.hint_show_id point at
-- shows with ON DELETE SET NULL, and show_hashtags with ON DELETE CASCADE, so
-- deleting a show would silently strip approved social sales of their show and
-- drop its hashtags. Merging left them on the duplicate.
--
--   delete_show(): also refuses a show with approved social sales or hashtags
--                  (returns has_social_sales / has_hashtags with counts).
--   merge_shows(): also moves social sales, pending extractions, post hints
--                  and hashtags to the show being kept (a hashtag the kept show
--                  already has is dropped from the duplicate).

create or replace function public.delete_show(p_show_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sales   int;
  v_social  int := 0;
  v_tags    int := 0;
  v_sellers int;
  v_cards   int;
begin
  if not public.is_platform_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if not exists (select 1 from public.shows where id = p_show_id) then
    return jsonb_build_object('error', 'not_found');
  end if;

  select count(*) into v_sales from public.show_floor_transactions where show_id = p_show_id;
  if v_sales > 0 then
    return jsonb_build_object('error', 'has_sales', 'sales', v_sales);
  end if;
  if to_regclass('public.social_sales') is not null then
    execute 'select count(*) from public.social_sales where show_id = $1' into v_social using p_show_id;
  end if;
  if v_social > 0 then
    return jsonb_build_object('error', 'has_social_sales', 'social_sales', v_social);
  end if;
  if to_regclass('public.show_hashtags') is not null then
    execute 'select count(*) from public.show_hashtags where show_id = $1' into v_tags using p_show_id;
  end if;
  if v_tags > 0 then
    return jsonb_build_object('error', 'has_hashtags', 'hashtags', v_tags);
  end if;

  delete from public.show_inventory where show_id = p_show_id;
  get diagnostics v_cards = row_count;
  delete from public.show_sellers where show_id = p_show_id;
  get diagnostics v_sellers = row_count;
  update public.show_requests
     set status = 'pending', show_id = null, reviewed_at = null, reviewed_by = null
   where show_id = p_show_id;
  update public.shows set merged_into = null where merged_into = p_show_id;
  if to_regclass('public.show_events') is not null then
    execute 'delete from public.show_events where show_id = $1' using p_show_id;
  end if;
  delete from public.shows where id = p_show_id;
  return jsonb_build_object('ok', true, 'sellers_removed', v_sellers, 'cards_removed', v_cards);
end $$;

create or replace function public.merge_shows(p_from text, p_into text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sellers int;
  v_cards   int;
  v_social  int := 0;
  v_tags    int := 0;
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

  -- Social sales data follows the show. (show_floor_transactions is immutable
  -- and stays on the duplicate.)
  if to_regclass('public.social_sales') is not null then
    execute 'update public.social_sales set show_id = $2, updated_at = now() where show_id = $1' using p_from, p_into;
    get diagnostics v_social = row_count;
  end if;
  if to_regclass('public.social_extractions') is not null then
    execute 'update public.social_extractions set show_id = $2 where show_id = $1' using p_from, p_into;
  end if;
  if to_regclass('public.social_posts') is not null then
    execute 'update public.social_posts set hint_show_id = $2 where hint_show_id = $1' using p_from, p_into;
  end if;
  if to_regclass('public.show_hashtags') is not null then
    execute 'delete from public.show_hashtags f where f.show_id = $1
               and exists (select 1 from public.show_hashtags t where t.show_id = $2 and t.tag = f.tag)' using p_from, p_into;
    execute 'update public.show_hashtags set show_id = $2 where show_id = $1' using p_from, p_into;
    get diagnostics v_tags = row_count;
  end if;

  update public.shows set listed = false, seller_self_join = false, merged_into = p_into where id = p_from;
  return jsonb_build_object('ok', true, 'sellers_moved', v_sellers, 'cards_moved', v_cards,
                            'social_sales_moved', v_social, 'hashtags_moved', v_tags);
end $$;

revoke all on function public.delete_show(text) from public;
grant execute on function public.delete_show(text) to authenticated;
grant execute on function public.merge_shows(text, text) to authenticated;
