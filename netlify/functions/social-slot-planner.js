// social-slot-planner.js — weekly Instagram hashtag slot plan (§2A).
// Scheduled in netlify.toml. Instagram allows 30 unique hashtags per IG
// business account per rolling 7 days. This picks the coming week's tags into
// hashtag_slots: live show tags first (up to 20), then general tags ranked by
// approved sales in hashtag_yield over the last 14 days. A general tag that
// had a slot for the last two weeks and produced no approved sale is dropped.
//
// Planning is not using: a slot is only taken when a poller first queries the
// tag, through claim_hashtag_slot() (P.claimHashtagSlot), which enforces the
// 30-per-rolling-7-days cap in the database. Hashtag polling (ig-hashtag-poll)
// is not built until Meta App Review approves hashtag search; until then this
// only records the plan.

const P = require('../lib/social-pipeline');

const IG_ACCOUNT = process.env.SOCIAL_IG_ACCOUNT || 'cardshow.io';
const CAP = 30, SHOW_MAX = 20;

exports.handler = async () => {
  const db = P.getDb();
  if (!db) return { statusCode: 503 };
  const today = new Date();
  // Monday of this week (UTC), the same week_start claim_hashtag_slot() uses.
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekStart = P.isoDate(monday);
  const weekEnd = P.isoDate(P.addDays(today, 7));

  const { data: tags } = await db.from('show_hashtags').select('*').eq('active', true);
  const showTags = (tags || []).filter(t => t.tier === 'show'
    && (!t.active_from || t.active_from <= weekEnd) && (!t.active_until || t.active_until >= weekStart));
  const general = (tags || []).filter(t => t.tier === 'general');

  const since = P.isoDate(P.addDays(today, -14));
  const { data: yields } = await db.from('hashtag_yield').select('tag, approved').gte('day', since);
  const approved = {};
  (yields || []).forEach(y => { approved[y.tag] = (approved[y.tag] || 0) + y.approved; });

  const { data: recentSlots } = await db.from('hashtag_slots').select('tag, week_start')
    .eq('ig_account', IG_ACCOUNT).gte('week_start', since);
  const weeksHeld = {};
  (recentSlots || []).forEach(s => { weeksHeld[s.tag] = (weeksHeld[s.tag] || 0) + 1; });

  // Hard cap: tags already queried in the rolling 7 days still hold a slot.
  const { data: live } = await db.from('hashtag_slots').select('tag')
    .eq('ig_account', IG_ACCOUNT).gte('first_queried_at', P.addDays(today, -7).toISOString());
  const held = new Set((live || []).map(s => s.tag));

  const plan = [];
  const add = (tag, tier) => {
    if (plan.some(p => p.tag === tag)) return;
    const used = new Set([...held, ...plan.map(p => p.tag)]);
    if (!used.has(tag) && used.size >= CAP) return;
    plan.push({ tag, tier });
  };
  showTags.slice(0, SHOW_MAX).forEach(t => add(t.tag, 'show'));
  general
    .filter(t => !((weeksHeld[t.tag] || 0) >= 2 && !(approved[t.tag] > 0)))
    .sort((a, b) => (approved[b.tag] || 0) - (approved[a.tag] || 0))
    .forEach(t => add(t.tag, 'general'));

  if (plan.length) {
    await db.from('hashtag_slots').upsert(
      plan.map(p => ({ ig_account: IG_ACCOUNT, tag: p.tag, tier: p.tier, week_start: weekStart })),
      { onConflict: 'ig_account,tag,week_start', ignoreDuplicates: true });
  }
  console.log(`[social-slot-planner] ${plan.length} tag(s) planned for week of ${weekStart}`);
  return { statusCode: 200 };
};
