-- GTCR registration lifecycle (Option A: register graded cards while the seller
-- owns them; remove on sale, delete, detail change, trust flag or consent
-- withdrawal). See "Trust Check via GTCR" in CLAUDE.md. Safe to re-run.
--
-- owner_email: GTCR only removes a registration when the email matches the one
-- it was registered with, so the email used at registration is stored and
-- reused, rather than the seller's current login email.
-- 'failed' rows record a registration GTCR rejected, so the same card isn't
-- retried on every reconcile. They are not active registrations.

ALTER TABLE gtcr_registrations
  ADD COLUMN IF NOT EXISTS owner_email              text,
  ADD COLUMN IF NOT EXISTS gtcr_registration_id     text,
  ADD COLUMN IF NOT EXISTS gtcr_registration_number text,
  ADD COLUMN IF NOT EXISTS seller_linked            boolean,
  ADD COLUMN IF NOT EXISTS gtcr_error               text,
  ADD COLUMN IF NOT EXISTS attempted_at             timestamptz;

ALTER TABLE gtcr_registrations DROP CONSTRAINT IF EXISTS gtcr_registrations_status_check;
ALTER TABLE gtcr_registrations
  ADD CONSTRAINT gtcr_registrations_status_check
  CHECK (status IN ('registered', 'removed', 'failed'));

CREATE INDEX IF NOT EXISTS gtcr_registrations_inventory_idx
  ON gtcr_registrations (inventory_id);
