-- 20261030120000_show_mode_images.sql backfill. Run after the Show Mode sales
-- migration (see README). Prints PASS/FAIL lines.
insert into public.sellers (id, handle) values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'img_tester') on conflict do nothing;
insert into public.inventory (id, seller_id, card_title, status) values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'Has photo', 'Available'),
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'Catalog only', 'Available'),
  ('a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'Photo not uploaded', 'Available'),
  ('a0000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'Deleted photo', 'Available')
on conflict (id) do nothing;
insert into public.card_captures (id, seller_id, entry_point, crop_key, catalog_card_id, inventory_id, status, uploaded_at, created_at, deleted_at) values
  ('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'sell_card', 'k/1/crop.jpg', 'cat-old', 'a0000000-0000-4000-8000-000000000001', 'attached', now(), now() - interval '2 day', null),
  ('c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'sell_card', 'k/2/crop.jpg', 'cat-new', 'a0000000-0000-4000-8000-000000000001', 'attached', now(), now(), null),
  ('c0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'case_scan', null, 'cat-x', 'a0000000-0000-4000-8000-000000000002', 'attached', null, now(), null),
  ('c0000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'sell_card', 'k/4/crop.jpg', null, 'a0000000-0000-4000-8000-000000000003', 'attached', null, now(), null),
  ('c0000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'sell_card', 'k/5/crop.jpg', 'cat-del', 'a0000000-0000-4000-8000-000000000004', 'attached', now(), now(), now())
on conflict (id) do nothing;

\i ../../supabase/migrations/20261030120000_show_mode_images.sql
\i ../../supabase/migrations/20261030120000_show_mode_images.sql

select case when primary_capture_id = 'c0000000-0000-4000-8000-000000000002' and image_source = 'seller' and catalog_card_id = 'cat-new'
            then 'PASS' else 'FAIL' end || ' newest uploaded photo becomes the image, with its catalog id'
  from inventory where id = 'a0000000-0000-4000-8000-000000000001';
select case when primary_capture_id is null and catalog_card_id = 'cat-x' and image_source = 'stock'
            then 'PASS' else 'FAIL' end || ' catalog id only → stock image'
  from inventory where id = 'a0000000-0000-4000-8000-000000000002';
select case when primary_capture_id is null then 'PASS' else 'FAIL' end || ' photo not uploaded yet is not used'
  from inventory where id = 'a0000000-0000-4000-8000-000000000003';
select case when primary_capture_id is null and catalog_card_id is null then 'PASS' else 'FAIL' end || ' deleted photo ignored'
  from inventory where id = 'a0000000-0000-4000-8000-000000000004';
select case when (select share_handle from sellers limit 1) is false then 'PASS' else 'FAIL' end || ' share_handle defaults to off';
