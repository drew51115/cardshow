-- refresh_show_statuses(): status follows the dates. Run after the migrations
-- (see README). Prints PASS/FAIL lines.
insert into public.shows (id, name, status, start_date, end_date) values
  ('st_past',   'Past show',     'upcoming', current_date - 10, current_date - 8),
  ('st_live',   'Live show',     'upcoming', current_date - 1,  current_date + 1),
  ('st_today',  'One day',       'past',     current_date,      null),
  ('st_future', 'Future show',   'active',   current_date + 5,  current_date + 6),
  ('st_nodate', 'No dates',      'active',   null,              null)
on conflict (id) do update set status = excluded.status, start_date = excluded.start_date, end_date = excluded.end_date;
update public.shows set timezone = 'Pacific/Kiritimati' where id = 'st_future';  -- UTC+14: still upcoming

\i ../../supabase/migrations/20261029120000_show_auto_status.sql

select case when status = 'past'     then 'PASS' else 'FAIL' end || ' past show → past'          from shows where id = 'st_past';
select case when status = 'active'   then 'PASS' else 'FAIL' end || ' running show → active'     from shows where id = 'st_live';
select case when status = 'active'   then 'PASS' else 'FAIL' end || ' one-day show today → active' from shows where id = 'st_today';
select case when status = 'upcoming' then 'PASS' else 'FAIL' end || ' future show → upcoming'    from shows where id = 'st_future';
select case when status = 'active'   then 'PASS' else 'FAIL' end || ' no dates → unchanged'      from shows where id = 'st_nodate';
select case when public.refresh_show_statuses() = 0 then 'PASS' else 'FAIL' end || ' second run changes nothing';
set role authenticated;
do $$ begin perform public.refresh_show_statuses(); raise notice 'FAIL client can call refresh_show_statuses';
exception when insufficient_privilege then raise notice 'PASS client cannot call refresh_show_statuses'; end $$;
reset role;
