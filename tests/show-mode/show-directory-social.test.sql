-- delete_show() / merge_shows() with Social Sales data. Run after the
-- delete-show test; runs 20261105120000_show_directory_social_sales.sql
-- itself (twice). Creates minimal stand-ins for the social sales tables.
\set ON_ERROR_STOP on
create table if not exists public.social_sales (id uuid primary key default gen_random_uuid(), show_id text references public.shows(id) on delete set null, updated_at timestamptz default now());
create table if not exists public.social_extractions (id uuid primary key default gen_random_uuid(), show_id text references public.shows(id) on delete set null);
create table if not exists public.social_posts (id uuid primary key default gen_random_uuid(), hint_show_id text references public.shows(id) on delete set null);
create table if not exists public.show_hashtags (id uuid primary key default gen_random_uuid(), show_id text references public.shows(id) on delete cascade, tag text not null, unique nulls not distinct (tag, show_id));
\i ../../supabase/migrations/20261105120000_show_directory_social_sales.sql
\i ../../supabase/migrations/20261105120000_show_directory_social_sales.sql
insert into auth.users values ('a2000000-0000-0000-0000-00000000000a') on conflict do nothing;
insert into platform_admins values ('a2000000-0000-0000-0000-00000000000a') on conflict do nothing;
insert into shows (id, name) values ('s_social', 'Has social'), ('s_tag', 'Has tag'), ('s_dup', 'Dup'), ('s_keep', 'Keep');
insert into social_sales (show_id) values ('s_social'), ('s_dup'), ('s_dup');
insert into show_hashtags (show_id, tag) values ('s_tag', 'tagshow'), ('s_dup', 'shared'), ('s_dup', 'onlydup'), ('s_keep', 'shared');
insert into social_extractions (show_id) values ('s_dup');
insert into social_posts (hint_show_id) values ('s_dup');

create function pg_temp.expect(label text, got jsonb, want jsonb) returns void language plpgsql as $$
begin if got @> want then raise notice 'PASS  %', label; else raise exception 'FAIL  % got %', label, got; end if; end $$;
create function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if cond then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;

set role authenticated;
set request.jwt.claim.sub = 'a2000000-0000-0000-0000-00000000000a';
select pg_temp.expect('delete refused: approved social sales', delete_show('s_social'), '{"error":"has_social_sales","social_sales":1}');
select pg_temp.expect('delete refused: hashtags', delete_show('s_tag'), '{"error":"has_hashtags","hashtags":1}');
select pg_temp.expect('merge moves social data', merge_shows('s_dup', 's_keep'), '{"ok":true,"social_sales_moved":2,"hashtags_moved":1}');
reset role;
select pg_temp.ok('social sales now on the kept show', (select count(*) from social_sales where show_id = 's_keep') = 2 and not exists (select 1 from social_sales where show_id = 's_dup'));
select pg_temp.ok('extraction + post hint moved', exists (select 1 from social_extractions where show_id = 's_keep') and exists (select 1 from social_posts where hint_show_id = 's_keep'));
select pg_temp.ok('hashtags: unique one moved, shared one kept once', (select count(*) from show_hashtags where show_id = 's_keep') = 2 and not exists (select 1 from show_hashtags where show_id = 's_dup'));
select pg_temp.ok('shows still there', (select count(*) from shows where id in ('s_social', 's_tag')) = 2);
set role authenticated;
select pg_temp.expect('merged duplicate now deletable', delete_show('s_dup'), '{"ok":true}');
reset role;
\echo ALL PASS show-directory-social
