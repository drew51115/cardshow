-- scan_corrections: one row per field a seller changed after a card scan,
-- before saving. Written fire-and-forget by _logScanCorrections() in app.html
-- from Add Card, Scan-to-Sell POS, Log a Manual Sale and Bulk Scan review.
-- Used to measure which fields the scanner gets wrong in practice.
-- Idempotent — safe to re-run.

create table if not exists scan_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  seller_id uuid references sellers(id),
  inventory_id uuid,
  scan_path text not null,        -- add_card | pos | manual_sale | bulk
  field text not null,
  scanned_value text,
  final_value text,
  confidence numeric,
  flags text[]
);

create index if not exists scan_corrections_field_idx on scan_corrections (scan_path, field);

alter table scan_corrections enable row level security;

drop policy if exists "sellers insert own corrections" on scan_corrections;
create policy "sellers insert own corrections" on scan_corrections
  for insert with check (seller_id = auth.uid());
