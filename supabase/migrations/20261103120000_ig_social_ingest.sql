-- Instagram Social Ingest — Phases 0 and 1 (see "Instagram Social Ingest" in CLAUDE.md).
--
-- Run AFTER 20261012120000_social_sales_v1.sql and 20261012140000_social_sales_v2.sql.
-- This extends v2's social_posts table rather than creating the spec's separate
-- social_posts table (the spec's ground rule 1: reuse the v2 pipeline). The spec's
-- `source` column is v2's `ingest_method` ('ig_tag' already allowed), and its
-- `status` values map onto v2's pipeline statuses (see CLAUDE.md).
--
-- Poster identity (poster_username / poster_ig_scoped_id) lives on social_posts
-- and featured_dealers only. It is never copied to a sale record.
--
-- Same access model as the v2 tables: RLS on, admins can SELECT, writes are
-- service-role only (Netlify functions). Idempotent — safe to re-run.

BEGIN;

-- ── Phase 0: integration_health ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_health (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration text NOT NULL,          -- 'meta_graph' | 'ig_tags_collector' | 'ig_source_check'
  status      text NOT NULL,          -- 'ok' | 'token_invalid' | 'permission_missing' | 'rate_limited' | 'error'
  detail      text,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_health_recent_idx ON integration_health (integration, created_at DESC);

-- ── Phase 1: social_posts columns for Instagram sources ─────────────────────
ALTER TABLE social_posts
  ADD COLUMN IF NOT EXISTS ig_media_id         text,
  ADD COLUMN IF NOT EXISTS permalink           text,
  ADD COLUMN IF NOT EXISTS media_type          text,      -- IMAGE | VIDEO | CAROUSEL_ALBUM
  ADD COLUMN IF NOT EXISTS poster_username     text,      -- identity lives here only
  ADD COLUMN IF NOT EXISTS poster_ig_scoped_id text,      -- IGSID, for story mentions (Phase 3)
  ADD COLUMN IF NOT EXISTS poster_consented    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_checked_at   timestamptz,  -- last weekly "still on Instagram?" check
  ADD COLUMN IF NOT EXISTS source_deleted_at   timestamptz;  -- set when that check finds it gone
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_ig_media_id_key ON social_posts (ig_media_id);
CREATE INDEX IF NOT EXISTS social_posts_posted_at_idx ON social_posts (posted_at DESC);

-- ── Phase 1: featured_dealers ───────────────────────────────────────────────
-- Filled at approval time (Phase 2). Created now so the schema is in place.
CREATE TABLE IF NOT EXISTS featured_dealers (
  username           text PRIMARY KEY,
  consent_source     text NOT NULL CHECK (consent_source IN ('tagged_post','story_mention','direct_opt_in')),
  first_consented_at timestamptz DEFAULT now(),
  opted_out_at       timestamptz
);

-- ── Access: admin read, service-role write ──────────────────────────────────
-- is_cardshow_admin() comes from 20261012140000_social_sales_v2.sql.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_health', 'featured_dealers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (is_cardshow_admin())',
                   t || '_admin_select', t);
  END LOOP;
END $$;

COMMIT;

-- Check (optional):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'social_posts' AND column_name IN ('ig_media_id','poster_username','poster_consented');
--   SELECT to_regclass('public.integration_health'), to_regclass('public.featured_dealers');
