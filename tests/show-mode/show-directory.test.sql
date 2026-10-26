-- Show directory: run after supabase-stub.sql, the self-join migration and the
-- show directory migration.
\set ON_ERROR_STOP on
insert into auth.users values ('a0000000-0000-0000-0000-00000000000a'), ('c0000000-0000-0000-0000-00000000000c') on conflict do nothing;
insert into sellers values ('c0000000-0000-0000-0000-00000000000c', 'carol') on conflict do nothing;
insert into platform_admins values ('a0000000-0000-0000-0000-00000000000a');
insert into shows (id, name, start_date, end_date, venue, city, state) values
  ('d_full', 'Monster Show!', current_date, current_date + 2, 'Cal Expo', 'Sacramento', 'CA'),
  ('d_dup',  'Monster Show',  current_date, current_date + 2, 'Cal Expo', 'Sacramento', 'CA'),
  ('d_bare', 'Half Done',     null, null, null, null, null),
  ('d_tz',   'Tz Show',       current_date - 1, current_date - 1, 'Hall', 'Honolulu', 'HI');
insert into inventory (id, seller_id, player) values ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 'X');

create function pg_temp.expect(label text, got jsonb, want jsonb) returns void language plpgsql as $$
begin
  if got @> want then raise notice 'PASS  %', label; else raise exception 'FAIL  % got %', label, got; end if;
end $$;
create function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if cond then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;

set role authenticated;
-- A seller can't list, and can't join an unlisted show.
set request.jwt.claim.sub = 'c0000000-0000-0000-0000-00000000000c';
select pg_temp.expect('seller cannot list', set_show_listed('d_full', true), '{"error":"forbidden"}');
select pg_temp.expect('unlisted show refused', join_show_as_seller('d_full'), '{"error":"not_listed"}');
select pg_temp.expect('request needs name + date', submit_show_request('{"name":"Nope"}'), '{"error":"missing_fields"}');
select pg_temp.expect('request submitted', submit_show_request('{"name":"Fresno Card Expo","start_date":"2027-01-10","city":"Fresno","state":"ca"}'), '{"ok":true,"already":false}');
select pg_temp.expect('same request twice = already', submit_show_request('{"name":"fresno card expo","start_date":"2027-01-10"}'), '{"already":true}');
select pg_temp.ok('seller sees only own request', (select count(*) from show_requests) = 1);
select pg_temp.expect('seller cannot resolve', resolve_show_request((select id from show_requests limit 1), 'declined', null, null), '{"error":"forbidden"}');

-- The platform owner lists shows.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';
select pg_temp.ok('is_platform_admin true for owner', is_platform_admin());
select pg_temp.expect('missing fields block listing', set_show_listed('d_bare', true), '{"error":"missing_fields","fields":["start_date","venue","city","state"]}');
select pg_temp.expect('list full show, slug made', set_show_listed('d_full', true), '{"ok":true,"listed":true}');
select pg_temp.ok('slug includes year-month', (select slug from shows where id='d_full') = 'monster-show-' || to_char(current_date, 'YYYY-MM'));
select pg_temp.expect('duplicate gets a numbered slug', set_show_listed('d_dup', true), '{"ok":true}');
select pg_temp.ok('numbered slug', (select slug from shows where id='d_dup') like 'monster-show-%-2');
select pg_temp.ok('owner sees all requests', (select count(*) from show_requests) = 1);
select pg_temp.expect('resolve needs a listed show', resolve_show_request((select id from show_requests limit 1), 'listed', 'd_bare', null), '{"error":"show_not_listed"}');
select pg_temp.expect('resolve listed', resolve_show_request((select id from show_requests limit 1), 'listed', 'd_full', 'Added'), '{"ok":true}');
reset role;
select pg_temp.ok('requester was added to the show', exists (select 1 from show_sellers where show_id='d_full' and seller_id='c0000000-0000-0000-0000-00000000000c' and self_joined));
select pg_temp.ok('request marked listed', (select status from show_requests limit 1) = 'listed');

-- Time zone: a show that ended yesterday in its own zone is over.
update shows set listed = true, timezone = 'Pacific/Honolulu' where id = 'd_tz';
set role authenticated;
set request.jwt.claim.sub = 'c0000000-0000-0000-0000-00000000000c';
select pg_temp.expect('listed + open show joins', join_show_as_seller('d_dup'), '{"ok":true}');
reset role;
insert into show_inventory values ('d_dup', 'd0000000-0000-0000-0000-000000000001');
-- (d_tz ended yesterday; result depends on the Honolulu clock being past its end date)
set role authenticated;
select pg_temp.expect('ended in its own time zone', join_show_as_seller('d_tz'), '{"error":"ended"}');

-- Merge the duplicate into the keeper.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';
select pg_temp.expect('merge needs two shows', merge_shows('d_dup', 'd_dup'), '{"error":"same_show"}');
select pg_temp.expect('merge', merge_shows('d_dup', 'd_full'), '{"ok":true,"sellers_moved":0,"cards_moved":1}');
reset role;
select pg_temp.ok('duplicate unlisted + closed + marked',
  (select not listed and seller_self_join = false and merged_into = 'd_full' from shows where id = 'd_dup'));
select pg_temp.ok('card moved to keeper', exists (select 1 from show_inventory where show_id='d_full'));
select pg_temp.ok('nothing left on duplicate', not exists (select 1 from show_sellers where show_id='d_dup') and not exists (select 1 from show_inventory where show_id='d_dup'));
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';
select pg_temp.expect('merged show cannot be relisted', set_show_listed('d_dup', true), '{"error":"missing_fields","fields":["merged"]}');
