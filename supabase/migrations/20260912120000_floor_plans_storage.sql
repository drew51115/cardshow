-- Show Floor Phase 2 (visual floor map) requires a public `floor-plans`
-- Storage bucket, documented in CLAUDE.md as a manual dashboard step —
-- but a "Public" bucket in the Supabase dashboard only makes reads public.
-- It grants no INSERT permission on its own; without an explicit RLS
-- policy on storage.objects, _floorUploadPlan()'s upload() call is
-- rejected by RLS with no policy matched, and the organizer sees a
-- generic "Upload failed" toast with no indication why. Same category of
-- gap already solved once for Trade Zone's buckets — this mirrors that
-- migration's pattern (bucket insert + explicit read/insert policies).

insert into storage.buckets (id, name, public)
values ('floor-plans', 'floor-plans', true)
on conflict (id) do nothing;

-- Public read (defensive — public buckets already serve objects without
-- this, but an explicit policy keeps dashboard-based access consistent).
drop policy if exists "floor_plans_public_read" on storage.objects;
create policy "floor_plans_public_read"
  on storage.objects for select
  using (bucket_id = 'floor-plans');

-- Only an authenticated session (organizer/admin) can upload or replace
-- a floor plan. Matches this app's admin-auth model (Supabase Auth +
-- admins table gate) — an anonymous/buyer session has no business
-- writing here.
drop policy if exists "floor_plans_authenticated_insert" on storage.objects;
create policy "floor_plans_authenticated_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'floor-plans');

-- _floorUploadPlan() calls upload(..., { upsert: true }) so re-uploading
-- a plan for the same show replaces the existing object — that upsert
-- compiles to an UPDATE when the row already exists, which needs its
-- own policy distinct from INSERT (same RLS shape Postgres requires
-- everywhere else in this app, e.g. show_inventory's insert-only gap
-- documented under "sellerPublishToShow() — skip already-published
-- cards" in CLAUDE.md).
drop policy if exists "floor_plans_authenticated_update" on storage.objects;
create policy "floor_plans_authenticated_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'floor-plans')
  with check (bucket_id = 'floor-plans');
