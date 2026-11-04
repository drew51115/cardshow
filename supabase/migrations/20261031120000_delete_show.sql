-- Show Directory: delete a show (platform owner only). Run after
-- 20261028120000_show_directory.sql. Safe to run more than once.
--
-- delete_show(p_show_id) removes the show, its seller list, its published-card
-- links and its show_events. It refuses a show with recorded sales:
-- show_floor_transactions is immutable and points at the show, so those shows
-- are unlisted or merged instead. A seller request linked to the deleted show
-- goes back to pending. A show merged into this one is unlinked.

create or replace function public.delete_show(p_show_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sales   int;
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

revoke all on function public.delete_show(text) from public;
grant execute on function public.delete_show(text) to authenticated;
