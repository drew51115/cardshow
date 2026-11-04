-- Show status follows the show's dates, automatically:
--   'upcoming' before start_date, 'active' from start_date through end_date,
--   'past' after end_date.
-- "Today" is the show's own date in shows.timezone when it's set, else
-- America/Los_Angeles (a US show's day ends last there, so nothing turns Past
-- early). Shows with no start_date keep the status they have.
-- Needs _show_last_day() from 20261027120000_seller_self_join.sql.
-- netlify/functions/refresh-show-statuses.js calls this every hour.
-- Safe to run more than once.

create or replace function public.refresh_show_statuses()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  update public.shows s
     set status = d.new_status
    from (
      select id,
             case when today < first_day then 'upcoming'
                  when today > last_day  then 'past'
                  else 'active' end as new_status
        from (
          select s2.id,
                 nullif(to_jsonb(s2)->>'start_date', '')::date as first_day,
                 public._show_last_day(s2)                     as last_day,
                 (now() at time zone coalesce(
                    (select name from pg_timezone_names where name = to_jsonb(s2)->>'timezone'),
                    'America/Los_Angeles'))::date               as today
            from public.shows s2
        ) x
       where first_day is not null and last_day is not null
    ) d
   where s.id = d.id and s.status is distinct from d.new_status;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.refresh_show_statuses() from public;
grant execute on function public.refresh_show_statuses() to service_role;

-- Fix every existing show now.
select public.refresh_show_statuses();
