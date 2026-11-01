// extract-social-sale-background.js — Social Sale Ingestion, stage 1 (§3).
// Netlify background function (15 min limit, answers 202 immediately).
//
// POST { post_id? } with x-social-pipeline-secret. Claims queued posts (the
// given one, or up to BATCH), sends every image plus the caption to Claude in
// one call, runs the deterministic checks (single-card gate, caption prices,
// asking-vs-sold rules, cert format), writes social_extractions rows, then
// kicks verify-certs-background.

const P = require('../lib/social-pipeline');

const BATCH = 5;

exports.handler = async (event) => {
  if (!P.isPipelineCall(event)) return { statusCode: 401 };
  const db = P.getDb();
  if (!db) { console.error('[social-extract] no service key'); return { statusCode: 503 }; }
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { /* empty */ }
  const base = input.base || P.siteBase(event);

  const { data: posts, error } = await db.rpc('claim_social_posts', { p_limit: BATCH, p_post_id: input.post_id || null });
  if (error) { console.error('[social-extract] claim failed:', error.message); return { statusCode: 500 }; }

  let extracted = 0;
  for (const post of posts || []) {
    try {
      if (await extractOne(db, post)) extracted++;
    } catch (err) {
      console.error(`[social-extract] post ${post.id} failed:`, err.message);
      const failed = post.attempts >= 3;
      await db.from('social_posts').update({
        status: failed ? 'failed' : 'queued',
        error: String(err.message).slice(0, 500),
        claimed_at: null,
        purge_after: failed ? P.addDays(new Date(), P.RETENTION_DAYS).toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq('id', post.id);
    }
  }

  if (extracted) await P.kickStage(base, 'verify-certs-background', input.post_id ? { post_id: input.post_id } : {});
  // More queued work than one batch: keep going in a fresh invocation.
  if (!input.post_id && (posts || []).length === BATCH) await P.kickStage(base, 'extract-social-sale-background', {});
  return { statusCode: 202 };
};

async function loadImages(db, postId) {
  const { data: media } = await db.from('social_post_media')
    .select('image_index, storage_path, media_type').eq('post_id', postId).is('purged_at', null).order('image_index');
  const images = [];
  for (const m of media || []) {
    const { data: blob, error } = await db.storage.from(P.EVIDENCE_BUCKET).download(m.storage_path);
    if (error || !blob) throw new Error(`download ${m.storage_path} failed: ${error?.message || 'empty'}`);
    images.push({ base64: Buffer.from(await blob.arrayBuffer()).toString('base64'), mediaType: m.media_type || 'image/jpeg' });
  }
  return images;
}

async function extractOne(db, post) {
  const images = await loadImages(db, post.id);
  if (!images.length) throw new Error('no images');
  const now = new Date().toISOString();
  const purgeAfter = P.addDays(new Date(), P.RETENTION_DAYS).toISOString();

  const { result, model, tokensIn, tokensOut } = await P.extractPost({ images, caption: post.caption_clean });
  const verdict = P.processExtraction(result, post.caption_clean);

  // Re-extraction replaces earlier rows for this post (rows still in the queue only).
  await db.from('social_extractions').delete().eq('post_id', post.id)
    .in('status', ['pending_verify', 'pending_resolve', 'review', 'rejected']);

  if (verdict.rows.length) {
    const rows = verdict.rows.map(r => ({ ...r, post_id: post.id }));
    const { error } = await db.from('social_extractions').upsert(rows, { onConflict: 'post_id,slab_index' });
    if (error) throw new Error(`insert extractions: ${error.message}`);
  }

  const terminal = verdict.postStatus !== 'extracted' || verdict.rows.every(r => r.status === 'rejected');
  await db.from('social_posts').update({
    status: verdict.postStatus,
    reject_reason: verdict.rejectReason || null,
    distinct_slab_count: Number(result?.distinct_slab_count ?? 0) || 0,
    extraction_raw: result,
    extraction_model: model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    error: null,
    claimed_at: null,
    purge_after: terminal ? purgeAfter : null,
    updated_at: now,
  }).eq('id', post.id);

  if (verdict.postStatus === 'extracted') await P.bumpYield(db, post.source_hashtag, { extracted: 1 });
  console.log(`[social-extract] post ${post.id}: ${verdict.postStatus}, ${verdict.rows.length} row(s), tokens ${tokensIn}/${tokensOut}`);
  return verdict.rows.some(r => r.status === 'pending_verify');
}
