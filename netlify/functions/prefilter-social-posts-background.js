// prefilter-social-posts-background.js — Social Sale Ingestion discovery funnel (§2A).
// Netlify background function.
//
// POST { post_id? } with x-social-pipeline-secret. Claims posts in
// 'pending_filter' and runs the three cheap stages (metadata, caption text,
// small-model image triage) via prefilterPost(). Survivors become 'queued' and
// extraction is kicked; the rest become 'filtered_out' with filter_stage and
// filter_reason. Per-stage counts land in hashtag_yield.
//
// Used by discovery pollers (once built) and by bulk drops submitted with
// "Apply the discovery filter".

const P = require('../lib/social-pipeline');

const BATCH = 20;

exports.handler = async (event) => {
  if (!P.isPipelineCall(event)) return { statusCode: 401 };
  const db = P.getDb();
  if (!db) { console.error('[social-prefilter] no service key'); return { statusCode: 503 }; }
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { /* empty */ }
  const base = input.base || P.siteBase(event);

  const { data: posts, error } = await db.rpc('claim_filter_posts', { p_limit: BATCH, p_post_id: input.post_id || null });
  if (error) { console.error('[social-prefilter] claim failed:', error.message); return { statusCode: 500 }; }

  let queued = 0;
  for (const post of posts || []) {
    try {
      if (await P.prefilterPost(db, post) === 'queued') queued++;
    } catch (err) {
      // Leave it pending; the sweep retries after the 15-minute claim expires.
      console.error(`[social-prefilter] post ${post.id} failed:`, err.message);
    }
  }

  if (queued) await P.kickStage(base, 'extract-social-sale-background', input.post_id ? { post_id: input.post_id } : {});
  if (!input.post_id && (posts || []).length === BATCH) await P.kickStage(base, 'prefilter-social-posts-background', {});
  return { statusCode: 202 };
};
