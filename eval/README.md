# Scan accuracy eval

Measures how often each scan path reads each field correctly, so every change
to the scanner is judged on numbers. Run it before and after any change to
`netlify/functions/_shared/scan-core.js`, `supabase/functions/bulk-scan/index.ts`,
or the capture code in `app.html`, and append the numbers to `BASELINE.md`.

## Fixtures

Put each photo in `fixtures/` with a matching `<name>.expected.json`:

```
fixtures/psa-trout-001.jpg
fixtures/psa-trout-001.expected.json
```

Single card:

```json
{
  "type": "single",
  "card": {
    "player": "Mike Trout", "year": "2011", "set": "Topps Update",
    "card_number": "US175", "parallel": "", "grader": "PSA", "grade": "10",
    "cert": "86234916"
  }
}
```

Showcase (bulk) photo:

```json
{ "type": "bulk", "cards": [ { "player": "…", "cert": "…" }, { "player": "…", "cert": null } ] }
```

Rules:
- Leave a field out to skip scoring it. Use `""` for "should be blank" (e.g. a base card's parallel).
- `cert: null` on a raw card scores an "invented" cert if the scanner returns one.
- `parallel` is the variant plus "Auto" if signed, without the serial (e.g. `"Gold Refractor Auto"`). The serial isn't scored in v1.
- Text compares case-insensitively; grades compare numerically ("GEM MT 10" = "10"); certs ignore spaces and dashes.
- Resize showcase photos to 1568px on the long edge to match what the app uploads.

Target set (40–60 photos):
- Slabs from PSA, BGS, SGC, CGC, plus at least 3 from other graders (TAG, HGA, CSG).
- Raw cards, including numbered parallels ("45/99") and autos.
- TCG: Pokemon plus at least one other game.
- 5 showcase photos (8–25 cards each) with every card labeled.
- Known-bad cases from seller reports.

Use real photos taken the way sellers take them (phone, show lighting), not scans.

## Running

```bash
netlify dev                                   # serves /.netlify/functions on :8888 (needs ANTHROPIC_API_KEY)
supabase functions serve bulk-scan            # for bulk fixtures

node eval/run.mjs                             # single → scan-card, bulk → bulk-scan
node eval/run.mjs --path vision-scan          # single-card fixtures through vision-scan
node eval/run.mjs --only single
```

Env: `FUNCTIONS_URL` (default `http://localhost:8888/.netlify/functions`),
`BULK_SCAN_URL` and `SUPABASE_JWT` (a signed-in seller's access token) for bulk.

Output: a per-field exact-match table for single-card and bulk, a cert breakdown
(correct / wrong / null, plus certs invented on raw cards), and
`eval/results-<timestamp>.json` with every prediction (git-ignored).

Each run calls the Anthropic API once per single-card fixture and once per showcase.
Bulk numbers here are pass 1 only — the slab-label pass (pass 2) runs in the
browser and isn't covered by this runner.
