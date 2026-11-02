-- Social Sale Ingestion v1 → v2 upgrade. See "Social Sale Ingestion" in CLAUDE.md.
--
-- Written against the schema 20261012120000_social_sales_v1.sql actually
-- created (the "v1.2" build: sticker/sold/asking prices + show_hashtags).
-- Run v1 first, then this. One transaction; safe to re-run.
--
-- What it changes:
--   * Column names line up with show_floor_transactions:
--       card_subject → player, card_year → year, card_variant → parallel
--       (social_sales, social_extractions); graded_certs subject → player,
--       brand → card_set, variety → parallel.
--   * grade becomes normalized text ('10', '9.5'), the same rendering as
--     show_floor_transactions' numeric grade.
--   * social_sales.card_fingerprint is rebuilt from show_floor_transactions'
--     own generated expression, so the two always match. Falls back to the
--     documented 7-field format if that table has no generated fingerprint.
--   * social_sales gains card_title, category, subcategory, is_test,
--     api_eligible. Asking price must equal sold price when the basis is
--     assumed_equal_sold.
--   * social_posts gains filter_stage / filter_reason and the 'filtered_out'
--     status for the discovery funnel.
--   * RPCs: consume_api_budget → claim_api_call; new claim_hashtag_slot
--     (30 unique tags per IG account per rolling 7 days) and claim_filter_posts
--     (discovery funnel queue). Service role only.
--   * Admins (admins.id = auth.uid()) can SELECT every social table.
--     Writes stay service-role only.
--   * v_comp_sales: test rows excluded on both sides; readable by signed-in
--     users, with each table's RLS deciding what they see (social rows:
--     admins and service role only).

BEGIN;

-- Rebuilt in step 8; it depends on columns changed below.
DROP VIEW IF EXISTS v_comp_sales;

-- ── 1. Column renames ────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('social_sales',       'card_subject', 'player'),
      ('social_sales',       'card_year',    'year'),
      ('social_sales',       'card_variant', 'parallel'),
      ('social_extractions', 'card_subject', 'player'),
      ('social_extractions', 'card_year',    'year'),
      ('social_extractions', 'card_variant', 'parallel'),
      ('graded_certs',       'subject',      'player'),
      ('graded_certs',       'brand',        'card_set'),
      ('graded_certs',       'variety',      'parallel')) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- ── 2. grade → normalized text ───────────────────────────────────────────────
-- The generated fingerprint depends on grade, so it is dropped first and
-- rebuilt in step 5.
ALTER TABLE social_sales DROP COLUMN IF EXISTS card_fingerprint;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_sales', 'social_extractions', 'graded_certs'] LOOP
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = t AND column_name = 'grade') = 'numeric' THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN grade TYPE text USING trim_scale(grade)::text', t);
    END IF;
  END LOOP;
END $$;

-- ── 3. New columns ───────────────────────────────────────────────────────────
ALTER TABLE social_sales
  ADD COLUMN IF NOT EXISTS card_title   text,
  ADD COLUMN IF NOT EXISTS category     text,
  ADD COLUMN IF NOT EXISTS subcategory  text,
  ADD COLUMN IF NOT EXISTS is_test      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_eligible boolean NOT NULL DEFAULT true;

ALTER TABLE social_extractions
  ADD COLUMN IF NOT EXISTS card_title  text,
  ADD COLUMN IF NOT EXISTS category    text,
  ADD COLUMN IF NOT EXISTS subcategory text;

UPDATE social_sales
   SET card_title = nullif(concat_ws(' ', year, card_set, player, parallel), '')
 WHERE card_title IS NULL;

-- Asking price equals sold price whenever the basis says so.
UPDATE social_sales SET asking_price = sold_price
 WHERE asking_price_basis = 'assumed_equal_sold' AND asking_price IS DISTINCT FROM sold_price;
UPDATE social_extractions SET asking_price = sold_price
 WHERE asking_price_basis = 'assumed_equal_sold' AND asking_price IS DISTINCT FROM sold_price;
DO $$ BEGIN
  ALTER TABLE social_sales ADD CONSTRAINT social_sales_assumed_ask_check
    CHECK (asking_price_basis <> 'assumed_equal_sold' OR asking_price = sold_price);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE social_extractions ADD CONSTRAINT social_extractions_assumed_ask_check
    CHECK (asking_price_basis IS DISTINCT FROM 'assumed_equal_sold' OR asking_price = sold_price);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reject-reason vocabulary: a sticker with no sold price is 'no_sold_price'.
UPDATE social_extractions SET reject_reason = 'no_sold_price' WHERE reject_reason = 'sticker_only';

-- ── 4. Discovery funnel on posts ─────────────────────────────────────────────
ALTER TABLE social_posts
  ADD COLUMN IF NOT EXISTS filter_stage  smallint,   -- 1 metadata | 2 caption | 3 image triage
  ADD COLUMN IF NOT EXISTS filter_reason text;

-- v1 marked funnel drops as rejected / 'funnel_<reason>'.
UPDATE social_posts
   SET status = 'filtered_out',
       filter_stage = CASE WHEN reject_reason = 'funnel_image_triage' THEN 3 ELSE 2 END,
       filter_reason = substr(reject_reason, 8),
       reject_reason = NULL
 WHERE status = 'rejected' AND reject_reason LIKE 'funnel\_%';

DO $$ BEGIN
  ALTER TABLE social_posts ADD CONSTRAINT social_posts_status_check CHECK (status IN (
    'draft', 'pending_filter', 'queued', 'extracting', 'extracted',
    'multi_card', 'no_slab', 'rejected', 'filtered_out', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS social_posts_source_tag_idx ON social_posts (source_hashtag, created_at);

-- ── 5. card_fingerprint, copied from show_floor_transactions ─────────────────
DO $$
DECLARE
  v_expr text;
  v_default text := 'lower(coalesce(player,'''')) || ''|'' || coalesce(year,'''') || ''|'' || lower(coalesce(card_set,'''')) || ''|'' || lower(coalesce(card_number,'''')) || ''|'' || lower(coalesce(parallel,'''')) || ''|'' || coalesce(grade,'''') || ''|'' || lower(coalesce(grader,''''))';

BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_expr
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.show_floor_transactions'::regclass
     AND a.attname = 'card_fingerprint' AND a.attgenerated = 's';

  IF v_expr IS NOT NULL THEN
    BEGIN
      EXECUTE format('ALTER TABLE social_sales ADD COLUMN card_fingerprint text GENERATED ALWAYS AS (%s) STORED', v_expr);
      RAISE NOTICE 'social_sales.card_fingerprint copied from show_floor_transactions: %', v_expr;
      RETURN;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Could not reuse show_floor_transactions fingerprint expression (%): %. Using the default.', v_expr, SQLERRM;
    END;
  ELSE
    RAISE WARNING 'show_floor_transactions.card_fingerprint is not a generated column; using the default 7-field expression.';
  END IF;
  EXECUTE format('ALTER TABLE social_sales ADD COLUMN card_fingerprint text GENERATED ALWAYS AS (%s) STORED', v_default);
END $$;
CREATE INDEX IF NOT EXISTS social_sales_fingerprint_idx ON social_sales (card_fingerprint);

-- ── 6. RPCs (service role only) ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS consume_api_budget(text, integer);

-- Atomically take one unit of today's budget. False when exhausted.
CREATE OR REPLACE FUNCTION claim_api_call(p_key text, p_limit integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_used integer;
BEGIN
  INSERT INTO api_budget (budget_key, day, used, daily_limit)
       VALUES (p_key, (now() AT TIME ZONE 'utc')::date, 0, p_limit)
  ON CONFLICT (budget_key, day) DO UPDATE SET daily_limit = EXCLUDED.daily_limit;

  UPDATE api_budget SET used = used + 1
   WHERE budget_key = p_key AND day = (now() AT TIME ZONE 'utc')::date AND used < daily_limit
  RETURNING used INTO v_used;
  RETURN v_used IS NOT NULL;
END $$;

-- Instagram allows 30 unique hashtags per business account per rolling 7 days.
-- Call before querying a tag. True if the tag already holds a slot or one was
-- free (the slot is then recorded); false if the cap is reached.
CREATE OR REPLACE FUNCTION claim_hashtag_slot(p_tag text, p_ig_account text DEFAULT 'cardshow.io')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_tag  text := lower(regexp_replace(p_tag, '^#', ''));
  v_used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hashtag_slots:' || p_ig_account));

  IF EXISTS (SELECT 1 FROM hashtag_slots
              WHERE ig_account = p_ig_account AND tag = v_tag
                AND first_queried_at >= now() - interval '7 days') THEN
    RETURN true;
  END IF;

  SELECT count(DISTINCT tag) INTO v_used FROM hashtag_slots
   WHERE ig_account = p_ig_account AND first_queried_at >= now() - interval '7 days';
  IF v_used >= 30 THEN
    RETURN false;
  END IF;

  INSERT INTO hashtag_slots (ig_account, tag, week_start, tier, first_queried_at)
  VALUES (p_ig_account, v_tag, date_trunc('week', now())::date,
          coalesce((SELECT tier FROM show_hashtags WHERE tag = v_tag ORDER BY tier DESC LIMIT 1), 'general'),
          now())
  ON CONFLICT (ig_account, tag, week_start) DO UPDATE SET first_queried_at = now();
  RETURN true;
END $$;

-- Claim posts waiting for the discovery funnel (status 'pending_filter').
CREATE OR REPLACE FUNCTION claim_filter_posts(p_limit integer, p_post_id uuid DEFAULT NULL)
RETURNS SETOF social_posts LANGUAGE sql AS $$
  UPDATE social_posts p
     SET claimed_at = now(), updated_at = now()
   WHERE p.id IN (
     SELECT id FROM social_posts
      WHERE status = 'pending_filter'
        AND (p_post_id IS NULL OR id = p_post_id)
        AND (claimed_at IS NULL OR claimed_at < now() - interval '15 minutes')
      ORDER BY created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING p.*;
$$;

REVOKE ALL ON FUNCTION claim_filter_posts(integer, uuid)            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_filter_posts(integer, uuid)            TO service_role;
REVOKE ALL ON FUNCTION claim_api_call(text, integer)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_hashtag_slot(text, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_social_posts(integer, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_social_extractions(text, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION bump_hashtag_yield(text, date, jsonb)         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_api_call(text, integer)                TO service_role;
GRANT EXECUTE ON FUNCTION claim_hashtag_slot(text, text)               TO service_role;
GRANT EXECUTE ON FUNCTION claim_social_posts(integer, uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION claim_social_extractions(text, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION bump_hashtag_yield(text, date, jsonb)         TO service_role;

-- ── 7. Admin read access ─────────────────────────────────────────────────────
-- SECURITY DEFINER so the check doesn't depend on the admins table's own RLS.
CREATE OR REPLACE FUNCTION is_cardshow_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM admins WHERE id = auth.uid());
$$;
REVOKE ALL ON FUNCTION is_cardshow_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_cardshow_admin() TO authenticated, service_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_posts', 'social_post_media', 'graded_certs', 'social_sales',
                           'social_extractions', 'social_watchlist', 'show_hashtags',
                           'hashtag_slots', 'hashtag_yield', 'api_budget'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (is_cardshow_admin())',
                   t || '_admin_select', t);
  END LOOP;
END $$;

-- ── 8. Comp view ─────────────────────────────────────────────────────────────
CREATE VIEW v_comp_sales WITH (security_invoker = true) AS
  SELECT
    t.id                           AS sale_id,
    coalesce(t.source, 'platform') AS source,
    t.sold_at::date                AS sold_date,
    t.sold_price::numeric          AS sold_price,
    t.asking_price::numeric        AS asking_price,
    t.grader::text                 AS grader,
    t.grade::text                  AS grade,
    t.cert_number::text            AS cert_number,
    t.card_title::text             AS card_title,
    t.player::text                 AS player,
    t.year::text                   AS year,
    t.card_set::text               AS card_set,
    t.card_number::text            AS card_number,
    t.parallel::text               AS parallel,
    t.card_fingerprint::text       AS card_fingerprint,
    t.show_id::text                AS show_id,
    true                           AS on_floor,
    true                           AS verified,
    1                              AS corroboration_count
  FROM show_floor_transactions t
  WHERE coalesce(t.is_test, false) = false
    AND coalesce(t.api_eligible, true) = true
  UNION ALL
  SELECT
    s.id, 'social_extract', s.sold_date, s.sold_price, s.asking_price,
    s.grader, s.grade, s.cert_number, s.card_title, s.player, s.year,
    s.card_set, s.card_number, s.parallel, s.card_fingerprint, s.show_id,
    s.on_floor, s.cert_verified, s.corroboration_count
  FROM social_sales s
  WHERE s.is_test = false
    AND s.api_eligible = true;

REVOKE ALL ON v_comp_sales FROM PUBLIC, anon;
GRANT SELECT ON v_comp_sales TO authenticated, service_role;

COMMIT;

-- ── Check (run after the upgrade) ───────────────────────────────────────────
-- Both rows must show the same expression.
--   SELECT c.relname, pg_get_expr(d.adbin, d.adrelid) AS fingerprint_expr
--     FROM pg_attribute a
--     JOIN pg_class c   ON c.oid = a.attrelid
--     JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
--    WHERE c.relname IN ('show_floor_transactions', 'social_sales')
--      AND a.attname = 'card_fingerprint';
