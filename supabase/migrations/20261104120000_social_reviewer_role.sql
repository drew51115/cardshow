-- Social Sales Phase 2: read-only reviewer role (see "Instagram Social Ingest" in CLAUDE.md).
--
-- Run AFTER 20261012120000_social_sales_v1.sql, 20261012140000_social_sales_v2.sql and
-- 20261103120000_ig_social_ingest.sql. Idempotent — safe to re-run.
--
-- A reviewer (e.g. Meta's App Review test login) can read every Social Sales view
-- but can't change anything:
--   * social-review-api.js lets reviewers call read actions only; every write
--     action checks the admins table and returns 403 read_only otherwise.
--   * The tables have no INSERT/UPDATE/DELETE policy for authenticated users, so
--     a reviewer (or anyone else) writing with the anon key is refused by RLS.
--
-- Add a reviewer: create the user in Authentication → Users, then
--   INSERT INTO social_reviewers (id, note) VALUES ('<auth user uuid>', 'Meta App Review');

BEGIN;

CREATE TABLE IF NOT EXISTS social_reviewers (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE social_reviewers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON social_reviewers FROM anon;
GRANT SELECT ON social_reviewers TO authenticated;
-- A signed-in user can see only their own row (the app uses it to pick read-only mode).
DROP POLICY IF EXISTS social_reviewers_self_select ON social_reviewers;
CREATE POLICY social_reviewers_self_select ON social_reviewers FOR SELECT TO authenticated USING (id = auth.uid());

CREATE OR REPLACE FUNCTION is_social_reviewer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM social_reviewers WHERE id = auth.uid());
$$;
REVOKE ALL ON FUNCTION is_social_reviewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_social_reviewer() TO authenticated, service_role;

-- Read access for reviewers, next to the existing admin read policies. No write policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_posts', 'social_post_media', 'social_extractions', 'social_sales',
                           'social_watchlist', 'show_hashtags', 'featured_dealers'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_reviewer_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (is_social_reviewer())',
                   t || '_reviewer_select', t);
  END LOOP;
END $$;

COMMIT;

-- Check (optional):
--   SELECT tablename, policyname FROM pg_policies WHERE policyname LIKE '%reviewer%' ORDER BY 1;
