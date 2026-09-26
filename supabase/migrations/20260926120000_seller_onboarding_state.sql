-- Getting started checklist + first-use tips, synced across a seller's devices.
-- Shape: { "gs": { "qr", "report", "dismissed", "collapsed" },
--          "tipsSeen": { "<tipKey>": true, ... }, "tipsOff": bool }
-- Written by app.html (_obSaveStateNow). Until this runs, the app keeps the
-- same state in localStorage only (per device). Safe to re-run.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS onboarding_state jsonb;
