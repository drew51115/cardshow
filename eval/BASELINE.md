# Scan accuracy baseline

Append a section after each phase with `node eval/run.mjs` output.

## Baseline (pre-change) — not yet captured

The fixture photos and an `ANTHROPIC_API_KEY` weren't available where the scan
changes were built, so no numbers exist yet. To capture the true baseline, check
out the commit before the scan changes (the parent of the "Scan accuracy" commits),
run `node eval/run.mjs` and `node eval/run.mjs --path vision-scan` against the
fixtures, and record the tables here. Then do the same on the current code.

| Path | player | year | set | card # | parallel | grader | grade | cert exact | cert wrong | cert null | invented |
|------|--------|------|-----|--------|----------|--------|-------|------------|------------|-----------|----------|
| scan-card (before) | | | | | | | | | | | |
| vision-scan (before) | | | | | | | | | | | |
| bulk pass 1 (before) | | | | | | | | | | | |
| scan-card (after) | | | | | | | | | | | |
| vision-scan (after) | | | | | | | | | | | |
| bulk pass 1 (after) | | | | | | | | | | | |

Note: run.mjs reads the current response shapes. The old `vision-scan` returns no
`gradeLabel` and the old `scan-card` no `serial_number`; both fall back cleanly.
