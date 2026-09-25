-- GTCR (Global Trading Card Registry) integration — Trust Check + consent-gated
-- registration. See "Trust Check via GTCR" in CLAUDE.md.
--
-- Every write to the four objects below goes through a Netlify function
-- (netlify/functions/gtcr-trust-check.js, netlify/functions/gtcr-registry.js)
-- using SUPABASE_SERVICE_KEY — the client never writes them directly. The new
-- tables therefore get RLS with a SELECT-own policy only and no client
-- INSERT/UPDATE/DELETE policy, so a seller can't forge a "clean" trust check
-- or a consent event. sellers.id = auth.uid() for every real seller (see
-- submitAuth() in app.html), which is what the SELECT policies key on.
--
-- Idempotent — safe to re-run.

-- ── 1. Per-card trust flag on inventory ─────────────────────────────────────
-- null      = no active GTCR match (or never checked / check failed open)
-- 'flagged' = cert matches an active stolen/lost report; hidden from buyers
--             and blocked from publishing until the seller acts
-- 'disputed'= seller chose "dispute and keep listing"; publishing allowed
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS trust_flag text;
DO $$ BEGIN
  ALTER TABLE inventory ADD CONSTRAINT inventory_trust_flag_check
    CHECK (trust_flag IS NULL OR trust_flag IN ('flagged', 'disputed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Trust Check log (one row per lookup) ─────────────────────────────────
-- `source` leaves room for a second stolen-card provider (e.g. Kapture) later.
CREATE TABLE IF NOT EXISTS cert_trust_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id       uuid REFERENCES inventory(id) ON DELETE SET NULL,
  seller_id          uuid REFERENCES sellers(id)   ON DELETE SET NULL,
  cert_number        text NOT NULL,
  grading_company    text,
  source             text NOT NULL DEFAULT 'gtcr',
  trigger            text,                 -- 'insert' | 'publish'
  matched            boolean NOT NULL,
  active_count       integer,
  has_stolen_report  boolean,
  has_lost_report    boolean,
  has_dispute_report boolean,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  seller_action      text,                 -- null | 'removed' | 'disputed'
  seller_action_at   timestamptz,
  seller_action_note text
);
CREATE INDEX IF NOT EXISTS cert_trust_checks_inventory_idx ON cert_trust_checks (inventory_id);
CREATE INDEX IF NOT EXISTS cert_trust_checks_seller_idx    ON cert_trust_checks (seller_id);

-- ── 3. Consent-evidence log (append-only) ───────────────────────────────────
-- CardShow's own record of the seller's consent action. GTCR only stores that
-- CardShow *asserted* consent; this table is the underlying evidence. The
-- latest row per seller is the current state. Never updated or deleted.
CREATE TABLE IF NOT EXISTS gtcr_consent_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id            uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  action               text NOT NULL CHECK (action IN ('granted', 'revoked')),
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  consent_copy_version text NOT NULL,
  ip_address           text,
  user_agent           text
);
CREATE INDEX IF NOT EXISTS gtcr_consent_events_seller_idx
  ON gtcr_consent_events (seller_id, occurred_at DESC);

-- ── 4. Registration log ─────────────────────────────────────────────────────
-- One row per card CardShow registered into GTCR. Removal (on consent
-- revocation) flips status in place and records when/why, so the audit trail
-- for a removal is as complete as for the registration itself.
CREATE TABLE IF NOT EXISTS gtcr_registrations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id          uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  inventory_id       uuid REFERENCES inventory(id) ON DELETE SET NULL,
  consent_event_id   uuid REFERENCES gtcr_consent_events(id),
  cert_number        text NOT NULL,
  grading_company    text NOT NULL,
  status             text NOT NULL CHECK (status IN ('registered', 'removed')),
  gtcr_status        text,                 -- 'registered' | 'already_registered'
  registered_at      timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  remove_reason      text,
  remove_gtcr_status text                  -- 'removed' | 'not_found'
);
CREATE INDEX IF NOT EXISTS gtcr_registrations_seller_status_idx
  ON gtcr_registrations (seller_id, status);
-- At most one active registration per seller + slab.
CREATE UNIQUE INDEX IF NOT EXISTS gtcr_registrations_active_uniq
  ON gtcr_registrations (seller_id, cert_number, grading_company)
  WHERE status = 'registered';

-- ── RLS: read-own only, no client writes ────────────────────────────────────
ALTER TABLE cert_trust_checks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtcr_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtcr_registrations  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cert_trust_checks_select_own" ON cert_trust_checks;
CREATE POLICY "cert_trust_checks_select_own" ON cert_trust_checks
  FOR SELECT USING (auth.uid() = seller_id);

DROP POLICY IF EXISTS "gtcr_consent_events_select_own" ON gtcr_consent_events;
CREATE POLICY "gtcr_consent_events_select_own" ON gtcr_consent_events
  FOR SELECT USING (auth.uid() = seller_id);

DROP POLICY IF EXISTS "gtcr_registrations_select_own" ON gtcr_registrations;
CREATE POLICY "gtcr_registrations_select_own" ON gtcr_registrations
  FOR SELECT USING (auth.uid() = seller_id);
