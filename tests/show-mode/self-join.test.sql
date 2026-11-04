-- Seller self-join: run after supabase-stub.sql and the self-join migration.
\set ON_ERROR_STOP on
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222') on conflict do nothing;
insert into sellers values ('11111111-1111-1111-1111-111111111111','alice'), ('22222222-2222-2222-2222-222222222222','bob') on conflict do nothing;
insert into shows (id, name, start_date, end_date) values
  ('open',   'Open Show',   current_date,      current_date + 1),
  ('closed', 'Closed Show', current_date,      current_date),
  ('old',    'Old Show',    current_date - 10, current_date - 9),
  ('nodate', 'No Date',     null, null);
update shows set seller_self_join = false where id = 'closed';
insert into show_sellers (show_id, seller_id, table_number) values ('closed', '22222222-2222-2222-2222-222222222222', '7');
insert into inventory (id, seller_id, player) values
  ('5e1f0000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'A'),
  ('5e1f0000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'B');

create function pg_temp.expect(label text, got jsonb, want jsonb) returns void language plpgsql as $$
begin
  if got @> want then raise notice 'PASS  %', label; else raise exception 'FAIL  % got %', label, got; end if;
end $$;

set role authenticated;
select pg_temp.expect('anon call refused', join_show_as_seller('open'), '{"error":"not_signed_in"}');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.expect('join open show', join_show_as_seller('open'), '{"ok":true,"already":false}');
select pg_temp.expect('join twice = already', join_show_as_seller('open'), '{"ok":true,"already":true}');
select pg_temp.expect('closed show refused', join_show_as_seller('closed'), '{"error":"closed"}');
select pg_temp.expect('ended show refused', join_show_as_seller('old'), '{"error":"ended"}');
select pg_temp.expect('show without dates allowed', join_show_as_seller('nodate'), '{"ok":true}');
select pg_temp.expect('unknown show', join_show_as_seller('nope'), '{"error":"not_found"}');
reset role;
do $$ begin
  if (select count(*) from show_sellers where show_id='open' and seller_id='11111111-1111-1111-1111-111111111111' and self_joined) <> 1
  then raise exception 'FAIL  one self_joined row'; end if; raise notice 'PASS  one self_joined row';
end $$;
insert into show_inventory values ('open','5e1f0000-0000-0000-0000-00000000000a');
insert into show_inventory values ('closed','5e1f0000-0000-0000-0000-00000000000b');
set role authenticated;
select pg_temp.expect('leave self-joined show', leave_show_as_seller('open'), '{"ok":true,"cards_removed":1}');
select pg_temp.expect('leave again = not joined', leave_show_as_seller('open'), '{"error":"not_joined"}');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect('organizer-added seller cannot leave', leave_show_as_seller('closed'), '{"error":"organizer_added"}');
reset role;
do $$ begin
  if exists (select 1 from show_inventory where show_id='open') then raise exception 'FAIL  cards off the show'; end if;
  if not exists (select 1 from show_sellers where show_id='closed') then raise exception 'FAIL  organizer row kept'; end if;
  raise notice 'PASS  cards removed, organizer row kept';
end $$;
