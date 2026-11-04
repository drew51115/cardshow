-- Show Mode v2, Phase 4: card images and the share-card handle opt-in.
-- Run after 20261023120000_show_mode_sales.sql. Safe to run more than once.
--
--   inventory.catalog_card_id  CardSight catalog card id. Show Mode shows the
--                              card's stock image from it when there's no
--                              seller photo (netlify/functions/card-image.js).
--   sellers.share_handle       seller opted in to showing their handle on
--                              sale share images. Off by default.
--
-- Backfill (one time, idempotent): cards that already have a saved Show Mode
-- photo get it as their image, and the photo's catalog id is copied over.

alter table public.inventory add column if not exists catalog_card_id text;
create index if not exists inventory_catalog_card_id_idx on public.inventory (catalog_card_id)
  where catalog_card_id is not null;

alter table public.sellers add column if not exists share_handle boolean not null default false;

do $$
begin
  if to_regclass('public.card_captures') is null then
    raise notice 'card_captures not found; run 20261023120000_show_mode_sales.sql first. Skipping backfill.';
    return;
  end if;

  -- Newest uploaded, non-deleted photo attached to each card becomes its image.
  update public.inventory i
     set primary_capture_id = c.id, image_source = 'seller'
    from (
      select distinct on (inventory_id) inventory_id, id
        from public.card_captures
       where inventory_id is not null and deleted_at is null
         and crop_key is not null and uploaded_at is not null
       order by inventory_id, created_at desc
    ) c
   where i.id = c.inventory_id and i.primary_capture_id is null;

  -- Catalog id from any attached photo that has one.
  update public.inventory i
     set catalog_card_id = c.catalog_card_id
    from (
      select distinct on (inventory_id) inventory_id, catalog_card_id
        from public.card_captures
       where inventory_id is not null and deleted_at is null and catalog_card_id is not null
       order by inventory_id, created_at desc
    ) c
   where i.id = c.inventory_id and i.catalog_card_id is null;
end $$;

-- Cards with only a catalog id show the stock image.
update public.inventory
   set image_source = 'stock'
 where primary_capture_id is null and catalog_card_id is not null
   and image_source is distinct from 'stock';
