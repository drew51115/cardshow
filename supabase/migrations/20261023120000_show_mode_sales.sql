-- Show Mode v2, Phase 2: sales, saved card captures, and the record/void
-- sale functions. See CLAUDE.md "Show Mode v2".
-- Idempotent: safe to run more than once in the Supabase SQL editor.
--
-- What this adds:
--   * sales            one row per Show Mode sale; client_sale_id (generated
--                      on the phone) makes a retried or offline-replayed sale
--                      land exactly once. Mutable status (completed/voided).
--   * card_captures    every scanned card's photos + identification, private
--                      to the seller. id is generated on the phone.
--   * card-captures    private Storage bucket; objects live under
--                      <seller uid>/<capture id>/...
--   * record_sale()    marks an item sold (or creates it, for "Add & sell" and
--                      manual sales), publishes it to the show, attaches the
--                      capture and writes the sales row, in one transaction.
--   * void_sale()      undo within 10 minutes: item back to Available, sale
--                      voided, and a reversing show_floor_transactions row.
-- show_floor_transactions stays append-only: an undo is a new row with a
-- negative sold_price and voids_transaction_id pointing at the original.

-- ── Columns the sale functions write (most already exist; see CLAUDE.md
--    "Pending DB Migrations") ───────────────────────────────────────────────
alter table public.inventory
  add column if not exists sold_price         numeric,
  add column if not exists payment_method     text,
  add column if not exists sale_notes         text,
  add column if not exists sold_time          text,
  add column if not exists sold_date          text,
  add column if not exists primary_capture_id uuid,
  add column if not exists image_source       text,
  add column if not exists source             text;

alter table public.show_floor_transactions
  add column if not exists client_sale_id       uuid,
  add column if not exists voids_transaction_id uuid;

create unique index if not exists show_floor_transactions_client_sale_id_key
  on public.show_floor_transactions (client_sale_id) where client_sale_id is not null;

-- ── sales ───────────────────────────────────────────────────────────────────
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  client_sale_id  uuid not null unique,
  seller_id       uuid not null,
  show_id         text references public.shows(id) on delete set null,
  inventory_id    uuid references public.inventory(id) on delete set null,
  capture_id      uuid,
  price           numeric not null check (price >= 0),
  payment_method  text not null,
  buyer_handle    text,
  source          text not null default 'show_mode' check (source in ('show_mode', 'manual_sale')),
  status          text not null default 'completed' check (status in ('completed', 'voided')),
  sold_at         timestamptz not null default now(),
  voided_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists sales_seller_sold_at_idx on public.sales (seller_id, sold_at desc);

alter table public.sales enable row level security;
drop policy if exists "sales_select_own" on public.sales;
create policy "sales_select_own" on public.sales
  for select using (seller_id = auth.uid());
-- No insert/update/delete policies: writes go through record_sale()/void_sale().
grant select on public.sales to authenticated;

-- ── card_captures ───────────────────────────────────────────────────────────
create table if not exists public.card_captures (
  id               uuid primary key,          -- generated on the phone (idempotency key)
  seller_id        uuid not null default auth.uid(),
  show_id          text,
  entry_point      text not null check (entry_point in ('sell_card', 'manual_sale', 'case_scan')),
  original_key     text,
  crop_key         text,
  back_key         text,
  catalog_card_id  text,
  cert_number      text,
  grader           text,
  grade            text,
  confidence       text,
  identification   jsonb,
  inventory_id     uuid references public.inventory(id) on delete set null,
  sale_id          uuid references public.sales(id) on delete set null,
  status           text not null default 'unattached' check (status in ('unattached', 'attached')),
  uploaded_at      timestamptz,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists card_captures_seller_idx on public.card_captures (seller_id, created_at desc);

alter table public.card_captures enable row level security;
drop policy if exists "card_captures_select_own" on public.card_captures;
create policy "card_captures_select_own" on public.card_captures
  for select using (seller_id = auth.uid());
drop policy if exists "card_captures_insert_own" on public.card_captures;
create policy "card_captures_insert_own" on public.card_captures
  for insert with check (seller_id = auth.uid());
drop policy if exists "card_captures_update_own" on public.card_captures;
create policy "card_captures_update_own" on public.card_captures
  for update using (seller_id = auth.uid()) with check (seller_id = auth.uid());
-- No delete policy: deleting a capture is a soft delete (deleted_at).
grant select, insert, update on public.card_captures to authenticated;

-- ── Private Storage bucket ──────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-captures', 'card-captures', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "card_captures_obj_select_own" on storage.objects;
create policy "card_captures_obj_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'card-captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "card_captures_obj_insert_own" on storage.objects;
create policy "card_captures_obj_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'card-captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "card_captures_obj_update_own" on storage.objects;
create policy "card_captures_obj_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'card-captures' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "card_captures_obj_delete_own" on storage.objects;
create policy "card_captures_obj_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'card-captures' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── record_sale ─────────────────────────────────────────────────────────────
-- Pass p_inventory_id for an item already in inventory, or p_new_item (a
-- cardToDbRow()-shaped object with a client-generated "id") to create the
-- item as part of the sale. Returns jsonb:
--   { created, sale_id, inventory_id, status, sold_at }   on success / replay
--   { error: 'already_sold', inventory_id }               item was already sold
create or replace function public.record_sale(
  p_client_sale_id  uuid,
  p_inventory_id    uuid,
  p_new_item        jsonb,
  p_show_id         text,
  p_price           numeric,
  p_payment_method  text,
  p_buyer_handle    text,
  p_sold_date       text,
  p_sold_time       text,
  p_capture_id      uuid,
  p_source          text default 'show_mode'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sale    public.sales%rowtype;
  v_inv_id  uuid;
  v_owner   uuid;
  v_status  text;
  v_item    jsonb;
  v_cols    text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_sale from public.sales where client_sale_id = p_client_sale_id;
  if found then
    if v_sale.seller_id <> v_uid then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    return jsonb_build_object('created', false, 'sale_id', v_sale.id, 'inventory_id', v_sale.inventory_id,
                              'status', v_sale.status, 'sold_at', v_sale.sold_at);
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  if coalesce(p_payment_method, '') = '' then
    raise exception 'payment_method_required' using errcode = '22023';
  end if;

  if p_inventory_id is not null then
    select seller_id, status into v_owner, v_status
      from public.inventory where id = p_inventory_id for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    if v_owner is distinct from v_uid then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if lower(coalesce(v_status, '')) = 'sold' then
      return jsonb_build_object('error', 'already_sold', 'inventory_id', p_inventory_id);
    end if;
    v_inv_id := p_inventory_id;
    update public.inventory
       set status = 'Sold', sold_price = p_price, payment_method = p_payment_method,
           sold_date = p_sold_date, sold_time = p_sold_time, updated_at = now()
     where id = v_inv_id;
  else
    if p_new_item is null then
      raise exception 'item_required' using errcode = '22023';
    end if;
    v_inv_id := coalesce(nullif(p_new_item->>'id', '')::uuid, gen_random_uuid());
    v_item := p_new_item || jsonb_build_object(
      'id', v_inv_id, 'seller_id', v_uid, 'status', 'Sold',
      'sold_price', p_price, 'payment_method', p_payment_method,
      'sold_date', p_sold_date, 'sold_time', p_sold_time,
      'source', p_source, 'created_at', now(), 'updated_at', now());
    -- Insert only the keys that are real columns here, so optional columns a
    -- project hasn't migrated yet (sport, category, ...) are skipped and
    -- columns not sent keep their defaults.
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'inventory'
       and c.is_generated = 'NEVER'
       and c.column_name in (select jsonb_object_keys(v_item));
    execute format('insert into public.inventory (%1$s) select %1$s from jsonb_populate_record(null::public.inventory, $1)', v_cols)
      using v_item;
  end if;

  -- The sale counts for the show (organizer analytics joins show_inventory).
  if p_show_id is not null and exists (select 1 from public.shows where id = p_show_id) then
    insert into public.show_inventory (show_id, card_id) values (p_show_id, v_inv_id)
    on conflict do nothing;
  end if;

  insert into public.sales (client_sale_id, seller_id, show_id, inventory_id, capture_id, price,
                            payment_method, buyer_handle, source)
  values (p_client_sale_id, v_uid,
          case when p_show_id is not null and exists (select 1 from public.shows where id = p_show_id) then p_show_id end,
          v_inv_id, p_capture_id, p_price, p_payment_method, nullif(p_buyer_handle, ''),
          coalesce(p_source, 'show_mode'))
  returning * into v_sale;

  if p_capture_id is not null then
    update public.card_captures
       set inventory_id = v_inv_id, sale_id = v_sale.id, status = 'attached'
     where id = p_capture_id and seller_id = v_uid;
    if found then
      update public.inventory
         set primary_capture_id = p_capture_id, image_source = 'seller'
       where id = v_inv_id and primary_capture_id is null;
    end if;
  end if;

  return jsonb_build_object('created', true, 'sale_id', v_sale.id, 'inventory_id', v_inv_id,
                            'status', v_sale.status, 'sold_at', v_sale.sold_at);
end;
$$;

revoke all on function public.record_sale(uuid, uuid, jsonb, text, numeric, text, text, text, text, uuid, text) from public, anon;
grant execute on function public.record_sale(uuid, uuid, jsonb, text, numeric, text, text, text, text, uuid, text) to authenticated;

-- ── void_sale ───────────────────────────────────────────────────────────────
-- Undo a sale by its client_sale_id, within 10 minutes (server clock).
-- Returns { voided, status, inventory_id } or { error: 'undo_window_expired' }.
create or replace function public.void_sale(p_client_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_sale  public.sales%rowtype;
  v_tx    uuid;
  v_cols  text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_sale from public.sales where client_sale_id = p_client_sale_id for update;
  if not found then
    raise exception 'sale_not_found' using errcode = 'P0002';
  end if;
  if v_sale.seller_id <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_sale.status = 'voided' then
    return jsonb_build_object('voided', false, 'status', 'voided', 'inventory_id', v_sale.inventory_id);
  end if;
  if now() - v_sale.sold_at > interval '10 minutes' then
    return jsonb_build_object('error', 'undo_window_expired', 'inventory_id', v_sale.inventory_id);
  end if;

  update public.sales set status = 'voided', voided_at = now() where id = v_sale.id;

  -- The item (including one created by "Add & sell" or a manual sale) goes
  -- back into the seller's case. Captures stay attached.
  update public.inventory
     set status = 'Available', sold_price = null, payment_method = null,
         sold_date = null, sold_time = null, sale_notes = null, updated_at = now()
   where id = v_sale.inventory_id and seller_id = v_uid;

  -- Reversing ledger row: a copy of the original with a negative price.
  select id into v_tx from public.show_floor_transactions
   where client_sale_id = v_sale.client_sale_id;
  if found and not exists (select 1 from public.show_floor_transactions where voids_transaction_id = v_tx) then
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into v_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'show_floor_transactions'
       and c.is_generated = 'NEVER' and c.is_identity = 'NO'
       and c.column_name not in ('id', 'created_at', 'sold_at', 'sold_price',
                                 'client_sale_id', 'voids_transaction_id');
    execute format(
      'insert into public.show_floor_transactions (%1$s, sold_at, sold_price, voids_transaction_id)
       select %1$s, now(), -sold_price, id from public.show_floor_transactions where id = $1', v_cols)
      using v_tx;
  end if;

  return jsonb_build_object('voided', true, 'status', 'voided', 'inventory_id', v_sale.inventory_id);
end;
$$;

revoke all on function public.void_sale(uuid) from public, anon;
grant execute on function public.void_sale(uuid) to authenticated;
