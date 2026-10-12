// social-pipeline-sweep.js — hourly safety net for Social Sale Ingestion.
// Scheduled in netlify.toml. Re-kicks any stage with work waiting (a lost
// hand-off, a background function that died, PSA cert lookups parked on
// yesterday's budget) and deletes intake drafts abandoned for over a day.

const P = require('../lib/social-pipeline');

exports.handler = async () => {
  const db = P.getDb();
  if (!db) { console.error('[social-sweep] no service key'); return { statusCode: 503 }; }
  const base = P.siteBase();

  // Abandoned drafts (an intake tab closed mid-upload).
  const cutoff = P.addDays(new Date(), -1).toISOString();
  const { data: drafts } = await db.from('social_posts').select('id').eq('status', 'draft').lt('created_at', cutoff).limit(200);
  for (const d of drafts || []) {
    const { data: media } = await db.from('social_post_media').select('storage_path').eq('post_id', d.id);
    if (media?.length) await db.storage.from(P.EVIDENCE_BUCKET).remove(media.map(m => m.storage_path));
    await db.from('social_posts').delete().eq('id', d.id);
  }

  const has = async (table, col, values) => {
    const { count } = await db.from(table).select('id', { count: 'exact', head: true }).in(col, values);
    return (count || 0) > 0;
  };
  const kicked = [];
  if (await has('social_posts', 'status', ['queued', 'extracting'])) {
    await P.kickStage(base, 'extract-social-sale-background', {}); kicked.push('extract');
  }
  if (await has('social_extractions', 'status', ['pending_verify'])) {
    await P.kickStage(base, 'verify-certs-background', {}); kicked.push('verify');
  }
  if (await has('social_extractions', 'status', ['pending_resolve'])) {
    await P.kickStage(base, 'resolve-and-route-background', {}); kicked.push('resolve');
  }
  console.log(`[social-sweep] drafts removed: ${(drafts || []).length}; kicked: ${kicked.join(', ') || 'none'}`);
  return { statusCode: 200 };
};
