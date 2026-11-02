-- Buyer-facing GTCR badge: when a card last passed a GTCR Trust Check with no
-- stolen, lost or dispute report. Written only by netlify/functions/gtcr-trust-check.js
-- (service key) after a clean check, and set back to null after a check that isn't clean.
-- Buyer pages read it to show "✓ GTCR CLEAR" / "No stolen or lost report".
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS trust_clear_at timestamptz;

-- A clean check only covers the cert it was run on. If the seller edits the
-- cert number or grader, drop the timestamp until the new cert is checked.
CREATE OR REPLACE FUNCTION inventory_clear_trust_on_cert_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cert_number IS DISTINCT FROM OLD.cert_number
     OR NEW.grader IS DISTINCT FROM OLD.grader THEN
    NEW.trust_clear_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_clear_trust_on_cert_change ON inventory;
CREATE TRIGGER inventory_clear_trust_on_cert_change
  BEFORE UPDATE OF cert_number, grader ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_clear_trust_on_cert_change();
