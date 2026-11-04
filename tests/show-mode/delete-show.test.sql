-- delete_show(): run after supabase-stub.sql, the self-join and show directory
-- migrations. Runs 20261031120000_delete_show.sql itself (twice).
\set ON_ERROR_STOP on
\i ../../supabase/migrations/20261031120000_delete_show.sql
\i ../../supabase/migrations/20261031120000_delete_show.sql
insert into auth.users values ('a1000000-0000-0000-0000-00000000000a'), ('c1000000-0000-0000-0000-00000000000c') on conflict do nothing;
insert into sellers values ('c1000000-0000-0000-0000-00000000000c', 'dana') on conflict do nothing;
insert into platform_admins values ('a1000000-0000-0000-0000-00000000000a') on conflict do nothing;
insert into shows (id, name) values ('x_del', 'Delete Me'), ('x_sold', 'Has Sales'), ('x_dup', 'Merged Dup');
update shows set merged_into = 'x_del' where id = 'x_dup';
insert into inventory (id, seller_id, player) values ('e1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-00000000000c', 'Y');
insert into show_sellers (show_id, seller_id, table_number) values ('x_del', 'c1000000-0000-0000-0000-00000000000c', '4');
insert into show_inventory values ('x_del', 'e1000000-0000-0000-0000-000000000001');
insert into show_requests (seller_id, name, start_date, status, show_id) values ('c1000000-0000-0000-0000-00000000000c', 'Delete Me', current_date, 'listed', 'x_del');
insert into show_floor_transactions (sold_price, show_id) values (50, 'x_sold');

create function pg_temp.expect(label text, got jsonb, want jsonb) returns void language plpgsql as $$
begin if got @> want then raise notice 'PASS  %', label; else raise exception 'FAIL  % got %', label, got; end if; end $$;
create function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if cond then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;

set role authenticated;
set request.jwt.claim.sub = 'c1000000-0000-0000-0000-00000000000c';
select pg_temp.expect('seller cannot delete', delete_show('x_del'), '{"error":"forbidden"}');
set request.jwt.claim.sub = 'a1000000-0000-0000-0000-00000000000a';
select pg_temp.expect('unknown show', delete_show('nope'), '{"error":"not_found"}');
select pg_temp.expect('show with sales refused', delete_show('x_sold'), '{"error":"has_sales","sales":1}');
select pg_temp.expect('delete', delete_show('x_del'), '{"ok":true,"sellers_removed":1,"cards_removed":1}');
reset role;
select pg_temp.ok('show row gone', not exists (select 1 from shows where id = 'x_del'));
select pg_temp.ok('links gone', not exists (select 1 from show_sellers where show_id = 'x_del') and not exists (select 1 from show_inventory where show_id = 'x_del'));
select pg_temp.ok('card itself kept', exists (select 1 from inventory where id = 'e1000000-0000-0000-0000-000000000001'));
select pg_temp.ok('request back to pending', (select status from show_requests where name = 'Delete Me') = 'pending' and (select show_id from show_requests where name = 'Delete Me') is null);
select pg_temp.ok('merged show unlinked', (select merged_into from shows where id = 'x_dup') is null);
select pg_temp.ok('show with sales still there', exists (select 1 from shows where id = 'x_sold'));
\echo ALL PASS delete-show
