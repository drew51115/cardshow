-- GTCR daily recheck (see "Trust Check via GTCR" → "Daily recheck" in CLAUDE.md).
-- inventory.trust_recheck_at = when the card's GTCR Trust Check last ran
-- (success or failure). The hourly gtcr-daily-recheck function re-checks
-- unsold graded cards where it's null or over 20h old, oldest first.
-- Run after 20261101120000_gtcr_buyer_badge.sql. Safe to re-run.

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS trust_recheck_at timestamptz;

CREATE INDEX IF NOT EXISTS inventory_trust_recheck_idx
  ON inventory (trust_recheck_at NULLS FIRST)
  WHERE cert_number IS NOT NULL AND grader IS NOT NULL;

-- A cert or grader edit clears the badge and puts the card at the front of
-- the recheck queue.
CREATE OR REPLACE FUNCTION inventory_clear_trust_on_cert_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cert_number IS DISTINCT FROM OLD.cert_number OR NEW.grader IS DISTINCT FROM OLD.grader THEN
    NEW.trust_clear_at := NULL;
    NEW.trust_recheck_at := NULL;
  END IF;
  RETURN NEW;
END $$;
