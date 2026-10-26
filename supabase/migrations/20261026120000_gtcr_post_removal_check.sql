-- Diagnostic: after CardShow removes a GTCR registration, the app runs a Trust
-- Check on that cert and saves the card_status GTCR reports, to show whether
-- GTCR still treats the card as registered. See "Trust Check via GTCR" in
-- CLAUDE.md. Safe to re-run.

ALTER TABLE gtcr_registrations
  ADD COLUMN IF NOT EXISTS post_removal_card_status text,
  ADD COLUMN IF NOT EXISTS post_removal_checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS post_removal_error       text;
