// purge-social-evidence.js — daily evidence purge for Social Sale Ingestion (D4).
// Scheduled in netlify.toml. Images belong to the poster: once a post's
// review is finished, social_posts.purge_after is set (+30 days by default,
// SOCIAL_EVIDENCE_RETENTION_DAYS). This deletes the stored images after that
// date and marks them purged. The derived sale facts are kept.

const P = require('../lib/social-pipeline');

exports.handler = async () => {
  const db = P.getDb();
  if (!db) { console.error('[social-purge] no service key'); return { statusCode: 503 }; }
  const now = new Date().toISOString();
  const { data: posts, error } = await db.from('social_posts')
    .select('id').lte('purge_after', now).is('evidence_purged_at', null).limit(500);
  if (error) { console.error('[social-purge]', error.message); return { statusCode: 500 }; }

  let removed = 0;
  for (const post of posts || []) {
    const { data: media } = await db.from('social_post_media').select('id, storage_path').eq('post_id', post.id).is('purged_at', null);
    if (media?.length) {
      const { error: rmErr } = await db.storage.from(P.EVIDENCE_BUCKET).remove(media.map(m => m.storage_path));
      if (rmErr) { console.warn(`[social-purge] ${post.id}:`, rmErr.message); continue; }
      await db.from('social_post_media').update({ purged_at: now }).in('id', media.map(m => m.id));
      removed += media.length;
    }
    await db.from('social_posts').update({ evidence_purged_at: now, updated_at: now }).eq('id', post.id);
  }
  console.log(`[social-purge] posts: ${(posts || []).length}, images removed: ${removed}`);
  return { statusCode: 200 };
};
