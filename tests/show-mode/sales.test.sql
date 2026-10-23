\set ON_ERROR_STOP 0
-- Expected: lines marked (expect ...) error; every other query returns the values its label names.
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
insert into sellers values ('11111111-1111-1111-1111-111111111111','alice'), ('22222222-2222-2222-2222-222222222222','bob');
insert into shows values ('show_a','Monster','Oct 9-11, 2026');
insert into inventory (id, seller_id, player, year, price) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Dylan Crews',2024,120),
 ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Bob Card',2020,50);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo '1. sell existing'
select public.record_sale('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',null,'show_a',114,'Venmo','@buyer','2026-10-23','2:05 PM',null);
\echo '2. replay same client id'
select public.record_sale('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',null,'show_a',114,'Venmo','@buyer','2026-10-23','2:05 PM',null);
select count(*) as sales_rows from sales;
\echo '3. double-sell with new client id'
select public.record_sale('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',null,'show_a',100,'Cash',null,'2026-10-23','2:06 PM',null);
\echo '4. sell another sellers item (expect forbidden)'
select public.record_sale('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002',null,'show_a',10,'Cash',null,null,null,null);
\echo '5. capture + new item (Add & sell / manual sale)'
insert into card_captures (id, entry_point, crop_key) values ('dddddddd-0000-0000-0000-000000000001','manual_sale','11111111-1111-1111-1111-111111111111/dddd/crop.jpg');
select public.record_sale('cccccccc-0000-0000-0000-000000000004',null,
  '{"id":"aaaaaaaa-0000-0000-0000-000000000009","player":"Elly De La Cruz","year":2023,"card_set":"Topps Chrome","price":40,"category":"Sports","not_a_column":"x"}'::jsonb,
  'show_a',35,'Cash',null,'2026-10-23','2:10 PM','dddddddd-0000-0000-0000-000000000001','manual_sale');
select id, seller_id, player, status, sold_price, source, primary_capture_id, image_source, item_type from inventory where id='aaaaaaaa-0000-0000-0000-000000000009';
select status, inventory_id is not null as has_inv, sale_id is not null as has_sale from card_captures;
select show_id, card_id from show_inventory order by card_id;
\echo '6. ledger row (client) then void'
insert into show_floor_transactions (sold_at, sold_price, asking_price, payment_method, inventory_id, player, year, seller_id, show_id, client_sale_id)
values (now(), 114, 120, 'Venmo', 'aaaaaaaa-0000-0000-0000-000000000001', 'Dylan Crews', 2024, '11111111-1111-1111-1111-111111111111', 'show_a', 'cccccccc-0000-0000-0000-000000000001');
\echo '6b. duplicate ledger insert with same client_sale_id (expect unique violation)'
insert into show_floor_transactions (sold_price, client_sale_id) values (114, 'cccccccc-0000-0000-0000-000000000001');
select public.void_sale('cccccccc-0000-0000-0000-000000000001');
select status, sold_price, payment_method, sold_date from inventory where id='aaaaaaaa-0000-0000-0000-000000000001';
select status from sales where client_sale_id='cccccccc-0000-0000-0000-000000000001';
select sold_price, price_delta, card_fingerprint, voids_transaction_id is not null as is_reversal, client_sale_id, show_id, source from show_floor_transactions order by sold_price desc;
\echo '7. void again (idempotent, no 2nd reversal)'
select public.void_sale('cccccccc-0000-0000-0000-000000000001');
select count(*) as ledger_rows from show_floor_transactions;
\echo '8. resell after undo works'
select public.record_sale('cccccccc-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001',null,'show_a',120,'Cash',null,'2026-10-23','2:20 PM',null);
\echo '9. direct writes rejected'
insert into sales (client_sale_id, seller_id, price, payment_method) values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 1, 'Cash');
update show_floor_transactions set sold_price = 0;
select count(*) filter (where sold_price = 0) as zeroed from show_floor_transactions;

\echo '10. bob view: cannot see alice sales/captures, cannot void her sale'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as bob_sales from sales; select count(*) as bob_captures from card_captures;
select public.void_sale('cccccccc-0000-0000-0000-000000000004');
insert into card_captures (id, seller_id, entry_point) values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'sell_card');
\echo '11. storage: bob writes into alice folder (expect RLS error), own folder ok'
insert into storage.objects (bucket_id, name) values ('card-captures', '11111111-1111-1111-1111-111111111111/x/crop.jpg');
insert into storage.objects (bucket_id, name) values ('card-captures', '22222222-2222-2222-2222-222222222222/x/crop.jpg');
select count(*) as bob_visible_objects from storage.objects;

\echo '12. undo window expired'
reset role;
update sales set sold_at = now() - interval '11 minutes' where client_sale_id='cccccccc-0000-0000-0000-000000000005';
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.void_sale('cccccccc-0000-0000-0000-000000000005');
\echo '13. anon cannot call'
reset role; set role anon; set request.jwt.claim.sub = '';
select public.record_sale(gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001',null,null,1,'Cash',null,null,null,null);
