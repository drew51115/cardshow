// social-intake.js — manual intake for Social Sale Ingestion (Phase 1).
// See "Social Sale Ingestion" in CLAUDE.md.
//
// Admin only (Supabase JWT + admins table). Images go up one per call so a
// 10-image carousel never hits Netlify's ~6MB request limit:
//
//   POST { action: 'create', post_url?, caption?, posted_at?, show_id?, ingest_method? }
//        → { success, post_id }                      (status 'draft')
//   POST { action: 'add_media', post_id, image_index, image_base64, media_type, width?, height? }
//        → { success }                               (409 duplicate_image if already ingested)
//   POST { action: 'submit', post_id, apply_funnel? }
//        → { success, status }                       (queued → extraction kicked)
//   POST { action: 'discard', post_id }             (deletes a draft and its images)
//
// No scraping (D2): a URL is stored only as a reference and dedup key. The
// screenshots are what gets read.

const P = require('../lib/social-pipeline');

const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 4_500_000; // ~3.3MB decoded; client compresses to ≤1600px long edge
const INGEST_METHODS = ['manual_url', 'manual_upload', 'bulk_drop', 'community_submit'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return P.json(405, { success: false, error: 'method_not_allowed' });
  const db = P.getDb();
  if (!db) return P.json(503, { success: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return P.json(400, { success: false, error: 'invalid_json' }); }

  const admin = await P.requireAdmin(db, event);
  if (!admin) return P.json(401, { success: false, error: 'admin_only' });

  try {
    switch (input.action) {
      case 'create':    return await create(db, admin, input);
      case 'add_media': return await addMedia(db, input);
      case 'submit':    return await submit(db, event, input);
      case 'discard':   return await discard(db, input.post_id);
      default:          return P.json(400, { success: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error('[social-intake]', err);
    return P.json(500, { success: false, error: 'internal_error', message: err.message });
  }
};

async function create(db, admin, input) {
  const url = P.norm(input.post_url);
  const parsed = url ? P.parsePostUrl(url) : null;
  if (url && !parsed) return P.json(400, { success: false, error: 'bad_url' });

  let postedAt = null;
  if (input.posted_at) {
    const d = new Date(input.posted_at);
    if (isNaN(d)) return P.json(400, { success: false, error: 'bad_posted_at' });
    postedAt = d.toISOString();
  }

  const method = INGEST_METHODS.includes(input.ingest_method)
    ? input.ingest_method : (parsed ? 'manual_url' : 'manual_upload');

  // With a URL the dedup key is final now. Without one it is provisional until
  // the first image arrives (see addMedia).
  const postKey = parsed ? P.postKeyFor(parsed.platform, parsed.platformPostId) : `pending:${P.sha256(String(Math.random()) + Date.now())}`;
  if (parsed) {
    const { data: dupe } = await db.from('social_posts').select('id, status').eq('post_key', postKey).maybeSingle();
    if (dupe) return P.json(409, { success: false, error: 'duplicate_post', post_id: dupe.id, status: dupe.status });
  }

  let hintShow = null;
  if (input.show_id) {
    const { data: show } = await db.from('shows').select('id').eq('id', input.show_id).maybeSingle();
    hintShow = show?.id || null;
  }

  const { data, error } = await db.from('social_posts').insert({
    post_key: postKey,
    platform: parsed ? parsed.platform : 'upload',
    post_url: url || null,
    ingest_method: method,
    caption_clean: P.cleanCaption(input.caption) || null,
    posted_at: postedAt,
    hint_show_id: hintShow,
    submitted_by: admin.id,
    status: 'draft',
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return P.json(409, { success: false, error: 'duplicate_post' });
    throw error;
  }
  return P.json(200, { success: true, post_id: data.id });
}

async function addMedia(db, input) {
  const { post_id: postId } = input;
  const index = Number(input.image_index);
  const b64 = String(input.image_base64 || '').replace(/^data:[^,]+,/, '');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(input.media_type) ? input.media_type : null;
  if (!postId || !Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) return P.json(400, { success: false, error: 'bad_index' });
  if (!b64 || !mediaType) return P.json(400, { success: false, error: 'image_required' });
  if (b64.length > MAX_IMAGE_B64) return P.json(413, { success: false, error: 'image_too_large' });

  const { data: post } = await db.from('social_posts').select('id, status, post_key').eq('id', postId).maybeSingle();
  if (!post) return P.json(404, { success: false, error: 'post_not_found' });
  if (post.status !== 'draft') return P.json(409, { success: false, error: 'post_not_draft' });

  const buf = Buffer.from(b64, 'base64');
  const hash = P.sha256(buf);
  const { data: seen } = await db.from('social_post_media').select('post_id').eq('sha256', hash).maybeSingle();
  if (seen) return P.json(409, { success: false, error: 'duplicate_image', post_id: seen.post_id });

  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const path = `${postId}/${index}.${ext}`;
  const { error: upErr } = await db.storage.from(P.EVIDENCE_BUCKET)
    .upload(path, buf, { contentType: mediaType, upsert: true });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  const { error } = await db.from('social_post_media').upsert({
    post_id: postId, image_index: index, storage_path: path, media_type: mediaType, sha256: hash,
    width: Number(input.width) || null, height: Number(input.height) || null,
  }, { onConflict: 'post_id,image_index' });
  if (error) {
    if (error.code === '23505') return P.json(409, { success: false, error: 'duplicate_image' });
    throw error;
  }

  // No URL: the first image's hash becomes the post key.
  if (index === 0 && post.post_key.startsWith('pending:')) {
    const { error: keyErr } = await db.from('social_posts')
      .update({ post_key: P.sha256(`upload:${hash}`), updated_at: new Date().toISOString() }).eq('id', postId);
    if (keyErr?.code === '23505') return P.json(409, { success: false, error: 'duplicate_post' });
  }
  return P.json(200, { success: true });
}

async function submit(db, event, input) {
  const { data: post } = await db.from('social_posts').select('*').eq('id', input.post_id).maybeSingle();
  if (!post) return P.json(404, { success: false, error: 'post_not_found' });
  if (post.status !== 'draft') return P.json(409, { success: false, error: 'post_not_draft', status: post.status });
  const { data: media } = await db.from('social_post_media').select('image_index').eq('post_id', post.id);
  if (!media?.length) return P.json(400, { success: false, error: 'no_images' });
  if (post.post_key.startsWith('pending:')) return P.json(400, { success: false, error: 'first_image_missing' });

  // Funnel stage 2 (§2A). Recorded for every post so yields can be measured;
  // only enforced when the submitter asks for it (testing the funnel on a bulk drop).
  const verdict = P.captionFilter(post.caption_clean, { fromShowTag: !!post.hint_show_id });
  const prefilter = { stage1: { pass: true }, stage2: verdict, enforced: !!input.apply_funnel };
  const update = { prefilter, updated_at: new Date().toISOString() };
  if (input.apply_funnel && !verdict.pass) {
    Object.assign(update, { status: 'rejected', reject_reason: `funnel_${verdict.reason}`,
      purge_after: P.addDays(new Date(), P.RETENTION_DAYS).toISOString() });
  } else {
    update.status = 'queued';
  }
  await db.from('social_posts').update(update).eq('id', post.id);
  if (update.status === 'queued') await P.kickStage(P.siteBase(event), 'extract-social-sale-background', { post_id: post.id });
  return P.json(200, { success: true, status: update.status, prefilter });
}

async function discard(db, postId) {
  const { data: post } = await db.from('social_posts').select('id, status').eq('id', postId).maybeSingle();
  if (!post) return P.json(404, { success: false, error: 'post_not_found' });
  if (post.status !== 'draft') return P.json(409, { success: false, error: 'post_not_draft' });
  const { data: media } = await db.from('social_post_media').select('storage_path').eq('post_id', postId);
  if (media?.length) await db.storage.from(P.EVIDENCE_BUCKET).remove(media.map(m => m.storage_path));
  await db.from('social_posts').delete().eq('id', postId);
  return P.json(200, { success: true });
}
