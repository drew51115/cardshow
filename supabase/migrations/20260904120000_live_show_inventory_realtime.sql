-- Enables Realtime broadcast on inventory and show_inventory so buyer-facing
-- pages (app.html's in-app Buyer view, show.html) can live-update when a
-- seller adds/edits/deletes a card mid-show, instead of requiring a manual
-- reload or the organizer re-pushing a share link. Wrapped in DO blocks so
-- re-running this migration doesn't error on "already a member" — same
-- idiom as supabase/migrations/20260825120000_trade_zone.sql.

do $$
begin
  alter publication supabase_realtime add table inventory;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table show_inventory;
exception when duplicate_object then null;
end $$;
