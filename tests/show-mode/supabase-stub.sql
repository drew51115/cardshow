do $$ begin if not exists (select 1 from pg_roles where rolname=$q$anon$q$) then create role anon nologin; create role authenticated nologin; end if; end $$;
create schema auth; create schema storage;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
grant usage on schema storage to authenticated; grant all on storage.objects to authenticated; grant execute on function storage.foldername(text) to authenticated;

create table public.sellers (id uuid primary key, handle text);
create table public.shows (id text primary key, name text, date text);
create table public.inventory (
  id uuid primary key default gen_random_uuid(), seller_id uuid, card_title text, player text, year int,
  card_set text, card_number text, parallel text, grader text, grade numeric, cert_number text,
  condition text, price numeric, status text default 'Available', item_type text default 'card',
  trust_flag text, created_at timestamptz default now(), updated_at timestamptz default now(),
  sold_price numeric, payment_method text, sold_time text);
create table public.show_inventory (show_id text references shows(id), card_id uuid references inventory(id), unique (show_id, card_id));
create table public.show_floor_transactions (
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), sold_at timestamptz,
  sold_price numeric, asking_price numeric, price_delta numeric generated always as (sold_price - asking_price) stored,
  payment_method text, source text not null default 'platform', inventory_id uuid, player text, year int,
  card_fingerprint text generated always as (lower(coalesce(player,'')) || '|' || coalesce(year::text,'')) stored,
  seller_id uuid, seller_handle text, show_id text, is_test boolean default false);
alter table public.show_floor_transactions enable row level security;
create policy sft_sel on public.show_floor_transactions for select using (true);
create policy sft_ins on public.show_floor_transactions for insert with check (true);
create policy sft_upd on public.show_floor_transactions as restrictive for update using (false);
create policy sft_del on public.show_floor_transactions as restrictive for delete using (false);
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
