-- Social Sale Ingestion (graded cards) — v1 schema. See "Social Sale Ingestion"
-- in CLAUDE.md and the build spec (§10).
--
-- Every table here is written and read ONLY by Netlify functions using
-- SUPABASE_SERVICE_KEY (netlify/functions/social-*.js). RLS is enabled with no
-- policies at all, so anon and authenticated clients can neither read nor write
-- them. The admin review UI goes through social-review-api.js, which checks the
-- caller's JWT against the `admins` table before touching anything.
--
-- D1: approved social sales live in social_sales, NOT show_floor_transactions,
-- so organizer GMV and sell-through stay platform-only. v_comp_sales unions
-- the two for comp consumers.
-- D3: no poster identity is stored on any sale record. social_posts keeps only
-- a hashed post key and a caption with @handles and URLs removed.
--
-- Idempotent — safe to re-run.

-- ── 1. Posts (one row per social post / manual submission) ──────────────────
CREATE TABLE IF NOT EXISTS social_posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256('<platform>:<platform_post_id>'), or sha256('upload:<first image sha>')
  -- when no URL was given. Unique: the same post is never ingested twice.
  post_key         text NOT NULL UNIQUE,
  platform         text NOT NULL CHECK (platform IN ('instagram','x','other','upload')),
  post_url         text,
  ingest_method    text NOT NULL CHECK (ingest_method IN (
                     'manual_url','manual_upload','bulk_drop',
                     'ig_mention','ig_tag','ig_hashtag','ig_watchlist',
                     'x_search','community_submit')),
  source_hashtag   text,                 -- the tag a discovery poller found it under
  caption_clean    text,                 -- @handles and URLs stripped (D3)
  posted_at        timestamptz,
  -- queued → extracting → extracted | multi_card | no_slab | rejected | failed
  status           text NOT NULL DEFAULT 'queued',
  reject_reason    text,
  prefilter        jsonb,                -- funnel stage verdicts (§2A), for yield measurement
  distinct_slab_count integer,
  extraction_raw   jsonb,                -- full model output, audit trail
  extraction_model text,
  tokens_in        integer,
  tokens_out       integer,
  attempts         integer NOT NULL DEFAULT 0,
  claimed_at       timestamptz,
  error            text,
  submitted_by     uuid,                 -- admin auth uid for manual intake (not the poster)
  hint_show_id     text REFERENCES shows(id) ON DELETE SET NULL,  -- show the submitter picked, if any
  purge_after      timestamptz,          -- evidence purge date (D4); set when review finishes
  evidence_purged_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_posts_status_idx ON social_posts (status, created_at);

-- ── 2. Media (evidence images, temporary — D4) ──────────────────────────────
CREATE TABLE IF NOT EXISTS social_post_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  image_index  integer NOT NULL,
  storage_path text NOT NULL,            -- social-evidence/<post_id>/<index>.jpg
  media_type   text NOT NULL DEFAULT 'image/jpeg',
  sha256       text NOT NULL UNIQUE,     -- catches screenshots of an already-ingested post
  width        integer,
  height       integer,
  purged_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, image_index)
);

-- ── 3. Grader cert cache (D6 — permanent) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS graded_certs (
  grader       text NOT NULL,
  cert_number  text NOT NULL,
  valid        boolean NOT NULL,         -- false = grader says no such cert
  year         text,
  brand        text,                     -- set / brand as the grader prints it
  card_number  text,
  subject      text,
  variety      text,
  grade        numeric,
  grade_label  text,
  category     text,
  raw          jsonb,
  source       text NOT NULL,            -- 'psa_api' | ...
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grader, cert_number)
);

-- ── 4. Approved sales (D1) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_sales (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grader              text NOT NULL,
  cert_number         text,
  grade               numeric,
  grade_label         text,
  card_year           text,
  card_set            text,
  card_number         text,
  card_subject        text,
  card_variant        text,
  sold_price          numeric NOT NULL CHECK (sold_price > 0),
  sold_price_source   text NOT NULL CHECK (sold_price_source IN ('caption_explicit','image_text','cash_shown','reviewer')),
  asking_price        numeric NOT NULL CHECK (asking_price > 0),
  asking_price_basis  text NOT NULL CHECK (asking_price_basis IN ('sticker','caption_ask','assumed_equal_sold','reviewer')),
  -- Only meaningful when the asking price was really observed (sticker / caption).
  discount_pct        numeric GENERATED ALWAYS AS (
                        CASE WHEN asking_price_basis IN ('sticker','caption_ask') AND asking_price > 0
                             THEN round((asking_price - sold_price) / asking_price, 4) END
                      ) STORED,
  currency            text NOT NULL DEFAULT 'USD',
  sold_date           date NOT NULL,
  sold_date_basis     text NOT NULL CHECK (sold_date_basis IN ('caption','posted_at','show_day','reviewer')),
  show_id             text REFERENCES shows(id) ON DELETE SET NULL,
  show_match_method   text,              -- 'hashtag' | 'name' | 'venue_city' | 'reviewer' | 'unattributed'
  on_floor            boolean NOT NULL,  -- false = approved_offfloor (excluded from show-floor comps)
  cert_verified       boolean NOT NULL DEFAULT false,
  stolen_flag         boolean NOT NULL DEFAULT false,
  approval_method     text NOT NULL CHECK (approval_method IN ('auto','reviewer')),
  corroboration_count integer NOT NULL DEFAULT 1,
  -- Same 7-field format as show_floor_transactions / price_cache.
  card_fingerprint    text GENERATED ALWAYS AS (
                        lower(coalesce(card_subject,'')) || '|' || coalesce(card_year,'') || '|' ||
                        lower(coalesce(card_set,''))     || '|' || lower(coalesce(card_number,'')) || '|' ||
                        lower(coalesce(card_variant,'')) || '|' || coalesce(grade::text,'') || '|' ||
                        lower(grader)
                      ) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_sales_cert_idx        ON social_sales (grader, cert_number, sold_date);
CREATE INDEX IF NOT EXISTS social_sales_fingerprint_idx ON social_sales (card_fingerprint);
CREATE INDEX IF NOT EXISTS social_sales_show_idx        ON social_sales (show_id);

-- ── 5. Extractions (one row per slab seen in a post) ────────────────────────
CREATE TABLE IF NOT EXISTS social_extractions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id            uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  slab_index         integer NOT NULL,
  image_index        integer,
  bbox               jsonb,              -- [x,y,w,h] normalized 0-1
  grader             text,
  cert_number        text,
  cert_partial       text,               -- best read with '?' for unreadable digits
  grade              numeric,
  grade_label        text,
  card_year          text,
  card_set           text,
  card_number        text,
  card_subject       text,
  card_variant       text,
  sticker_price      numeric,
  sold_price         numeric,
  sold_price_source  text,
  cash_bills_seen    text,
  asking_price       numeric,
  asking_price_basis text,
  currency           text DEFAULT 'USD',
  is_trade           boolean NOT NULL DEFAULT false,
  post_role          text,
  conf               jsonb,              -- model's per-field confidence
  -- Verification (§4)
  verify_status      text NOT NULL DEFAULT 'pending'
                     CHECK (verify_status IN ('pending','awaiting_budget','verified','not_found',
                                              'format_only','unsupported_grader','no_cert','error')),
  verified_cert      jsonb,              -- snapshot of the graded_certs row used
  card_match_score   numeric,
  cert_recovered     boolean NOT NULL DEFAULT false,   -- filled from cert_partial
  stolen_flag        boolean NOT NULL DEFAULT false,
  stolen_detail      jsonb,
  -- Resolution (§5–§8)
  comp_median        numeric,
  sanity_flag        text,               -- null = inside band | 'low' | 'high' | 'no_comp'
  show_id            text REFERENCES shows(id) ON DELETE SET NULL,
  show_match_method  text,
  show_score         numeric,
  sold_date          date,
  sold_date_basis    text,
  cert_score         numeric,
  price_score        numeric,
  confidence         numeric,
  auto_eligible      boolean NOT NULL DEFAULT false,   -- matches the §8 pattern (measured even while auto-approve is off)
  route_reasons      text[],             -- why it went to review
  -- pending_verify → pending_resolve → review | auto_approved
  --   → approved | approved_offfloor | rejected | duplicate
  status             text NOT NULL DEFAULT 'pending_verify',
  reject_reason      text,
  duplicate_of       uuid REFERENCES social_sales(id) ON DELETE SET NULL,
  social_sale_id     uuid REFERENCES social_sales(id) ON DELETE SET NULL,
  review_edits       jsonb,              -- field → {from, to}: labeled data for tuning (§9)
  edited_fields      text[],
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  claimed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, slab_index)
);
CREATE INDEX IF NOT EXISTS social_extractions_status_idx ON social_extractions (status, created_at);
CREATE INDEX IF NOT EXISTS social_extractions_cert_idx   ON social_extractions (grader, cert_number);

-- ── 6. Discovery registries (Phase 2 — built now, polled once App Review lands) ──
-- Never joined to sale records (D3).
CREATE TABLE IF NOT EXISTS social_watchlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    text NOT NULL CHECK (platform IN ('instagram','x')),
  account     text NOT NULL,             -- IG username for Business Discovery / X handle
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  last_polled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, account)
);

CREATE TABLE IF NOT EXISTS show_hashtags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id      text REFERENCES shows(id) ON DELETE CASCADE,   -- null = general hobby tag
  tag          text NOT NULL,            -- lowercase, no '#'
  tier         text NOT NULL CHECK (tier IN ('show','general')),
  active_from  date,                     -- show tier: 1 day before the show
  active_until date,                     -- show tier: 2 days after
  poll_minutes integer NOT NULL DEFAULT 60,
  official     boolean NOT NULL DEFAULT false,  -- supplied by the organizer
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tag, show_id)
);

-- One row per tag the slot planner assigned to an IG business account for a week.
CREATE TABLE IF NOT EXISTS hashtag_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_account    text NOT NULL DEFAULT 'cardshow.io',
  tag           text NOT NULL,
  ig_hashtag_id text,                    -- resolved by ig_hashtag_search (uses the slot)
  week_start    date NOT NULL,
  tier          text NOT NULL,
  first_queried_at timestamptz,          -- the 30-per-rolling-7-days cap counts from here
  last_polled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ig_account, tag, week_start)
);

-- Funnel counts per tag per day (§2A) — what each tag's slot is worth.
CREATE TABLE IF NOT EXISTS hashtag_yield (
  tag           text NOT NULL,
  day           date NOT NULL,
  seen          integer NOT NULL DEFAULT 0,
  stage1_pass   integer NOT NULL DEFAULT 0,   -- metadata
  stage2_pass   integer NOT NULL DEFAULT 0,   -- caption text
  stage3_pass   integer NOT NULL DEFAULT 0,   -- image triage
  extracted     integer NOT NULL DEFAULT 0,
  approved      integer NOT NULL DEFAULT 0,
  approved_on_floor integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tag, day)
);

-- Daily API call counters (PSA free tier is 100/day; X reads cost money).
CREATE TABLE IF NOT EXISTS api_budget (
  budget_key  text NOT NULL,             -- 'psa' | 'x_reads' | 'anthropic_extract' ...
  day         date NOT NULL,
  used        integer NOT NULL DEFAULT 0,
  daily_limit integer NOT NULL,
  PRIMARY KEY (budget_key, day)
);

-- ── 7. RLS: on, no policies (service key only) ──────────────────────────────
ALTER TABLE social_posts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_media   ENABLE ROW LEVEL SECURITY;
ALTER TABLE graded_certs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sales        ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_extractions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_watchlist    ENABLE ROW LEVEL SECURITY;
ALTER TABLE show_hashtags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hashtag_slots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hashtag_yield       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_budget          ENABLE ROW LEVEL SECURITY;

-- ── 8. Queue + budget RPCs (service_role only) ──────────────────────────────
-- Claim up to p_limit posts for extraction. A claim older than 15 minutes is
-- considered abandoned (background function died) and can be re-claimed.
CREATE OR REPLACE FUNCTION claim_social_posts(p_limit integer, p_post_id uuid DEFAULT NULL)
RETURNS SETOF social_posts LANGUAGE sql AS $$
  UPDATE social_posts p
     SET status = 'extracting', claimed_at = now(), attempts = p.attempts + 1, updated_at = now()
   WHERE p.id IN (
     SELECT id FROM social_posts
      WHERE (p_post_id IS NULL OR id = p_post_id)
        AND (status = 'queued' OR (status = 'extracting' AND claimed_at < now() - interval '15 minutes'))
        AND attempts < 3
      ORDER BY created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING p.*;
$$;

-- Claim extractions sitting in p_status (verify: 'pending_verify', resolve:
-- 'pending_resolve'). Stamps claimed_at so two workers never take the same row.
CREATE OR REPLACE FUNCTION claim_social_extractions(p_status text, p_limit integer, p_post_id uuid DEFAULT NULL)
RETURNS SETOF social_extractions LANGUAGE sql AS $$
  UPDATE social_extractions e
     SET claimed_at = now(), updated_at = now()
   WHERE e.id IN (
     SELECT id FROM social_extractions
      WHERE status = p_status
        AND (p_post_id IS NULL OR post_id = p_post_id)
        AND (claimed_at IS NULL OR claimed_at < now() - interval '15 minutes')
      ORDER BY created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING e.*;
$$;

-- Atomically take one unit of today's budget. Returns false when exhausted.
CREATE OR REPLACE FUNCTION consume_api_budget(p_key text, p_limit integer)
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

-- Add funnel counts for a tag (upsert-and-increment).
CREATE OR REPLACE FUNCTION bump_hashtag_yield(p_tag text, p_day date, p_counts jsonb)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO hashtag_yield AS y (tag, day, seen, stage1_pass, stage2_pass, stage3_pass, extracted, approved, approved_on_floor)
  VALUES (p_tag, p_day,
          coalesce((p_counts->>'seen')::int,0), coalesce((p_counts->>'stage1_pass')::int,0),
          coalesce((p_counts->>'stage2_pass')::int,0), coalesce((p_counts->>'stage3_pass')::int,0),
          coalesce((p_counts->>'extracted')::int,0), coalesce((p_counts->>'approved')::int,0),
          coalesce((p_counts->>'approved_on_floor')::int,0))
  ON CONFLICT (tag, day) DO UPDATE SET
    seen = y.seen + EXCLUDED.seen,
    stage1_pass = y.stage1_pass + EXCLUDED.stage1_pass,
    stage2_pass = y.stage2_pass + EXCLUDED.stage2_pass,
    stage3_pass = y.stage3_pass + EXCLUDED.stage3_pass,
    extracted = y.extracted + EXCLUDED.extracted,
    approved = y.approved + EXCLUDED.approved,
    approved_on_floor = y.approved_on_floor + EXCLUDED.approved_on_floor;
$$;

REVOKE ALL ON FUNCTION claim_social_posts(integer, uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_social_extractions(text, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION consume_api_budget(text, integer)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION bump_hashtag_yield(text, date, jsonb)          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_social_posts(integer, uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION claim_social_extractions(text, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION consume_api_budget(text, integer)             TO service_role;
GRANT EXECUTE ON FUNCTION bump_hashtag_yield(text, date, jsonb)          TO service_role;

-- ── 9. Comp view (D1) ───────────────────────────────────────────────────────
-- Platform sales + approved on-floor and off-floor social sales, one shape.
-- Columns of show_floor_transactions are cast to text/numeric so the union
-- doesn't depend on their exact declared types. Test rows and rows marked
-- api_eligible = false are excluded.
-- security_invoker: the view runs with the caller's rights, so social_sales'
-- RLS (no policies) still applies. Granted to service_role only.
-- Skipped once 20261012140000_social_sales_v2.sql has renamed the columns
-- (v2 rebuilds this view), so re-running v1 after v2 is harmless.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'social_sales' AND column_name = 'card_subject') THEN
    EXECUTE $v$
DROP VIEW IF EXISTS v_comp_sales;
CREATE VIEW v_comp_sales WITH (security_invoker = true) AS
  SELECT
    t.id                         AS sale_id,
    coalesce(t.source, 'platform') AS source,
    t.sold_at::date              AS sold_date,
    t.sold_price::numeric        AS sold_price,
    t.asking_price::numeric      AS asking_price,
    t.grader::text               AS grader,
    t.grade::text                AS grade,
    t.cert_number::text          AS cert_number,
    t.player::text               AS subject,
    t.year::text                 AS card_year,
    t.card_set::text             AS card_set,
    t.card_number::text          AS card_number,
    t.parallel::text             AS card_variant,
    t.card_fingerprint::text     AS card_fingerprint,
    t.show_id::text              AS show_id,
    true                         AS on_floor,
    true                         AS verified,
    1                            AS corroboration_count
  FROM show_floor_transactions t
  WHERE coalesce(t.is_test, false) = false
    AND coalesce(t.api_eligible, true) = true
  UNION ALL
  SELECT
    s.id, 'social_extract', s.sold_date, s.sold_price, s.asking_price,
    s.grader, s.grade::text, s.cert_number, s.card_subject, s.card_year,
    s.card_set, s.card_number, s.card_variant, s.card_fingerprint, s.show_id,
    s.on_floor, s.cert_verified, s.corroboration_count
  FROM social_sales s;
    $v$;
    EXECUTE $v$ REVOKE ALL ON v_comp_sales FROM PUBLIC, anon, authenticated $v$;
    EXECUTE $v$ GRANT SELECT ON v_comp_sales TO service_role $v$;
  END IF;
END $do$;

-- ── 10. Private evidence bucket (D4) ────────────────────────────────────────
-- Private: no storage.objects policies at all. Uploads, signed URLs for the
-- review UI, and the daily purge all use the service key.
INSERT INTO storage.buckets (id, name, public)
VALUES ('social-evidence', 'social-evidence', false)
ON CONFLICT (id) DO UPDATE SET public = false;
