// ig-tags-collector.js — Instagram tagged-post collector (IG Social Ingest spec, Phase 1).
// Scheduled every 3 hours in netlify.toml. See "Instagram Social Ingest" in CLAUDE.md.
//
// 1. GET /{IG_USER_ID}/tags (posts that tag @cardshow.io), newest first, until
//    a post we already have or one older than the lookback window.
// 2. For each new post, oldest first: insert a social_posts row (v2 table,
//    ingest_method 'ig_tag', poster_consented = true: tagging @cardshow.io is
//    consent to be featured), download its images into the private
//    social-evidence bucket right away (Instagram's CDN URLs expire), then hand
//    it to the v2 pipeline at status 'pending_filter'.
// 3. Kick prefilter-social-posts-background once. From there the v2 pipeline
//    does everything: caption filter + image triage → Claude extraction →
//    PSA cert check → show matching → review queue. Nothing here classifies or
//    extracts, and nothing writes a sale (approval is Phase 2).
// 4. One integration_health row per run ('ig_tags_collector').
//
// A post with no downloadable image (media_url missing, or a video without a
// thumbnail) is still queued; the v2 pipeline reads it from the caption alone.
//
// Credentials: the Meta token is only touched inside netlify/lib/meta-graph.js.

const P = require('../lib/social-pipeline');
const G = require('../lib/meta-graph');

const INTEGRATION = 'ig_tags_collector';
const FIELDS = 'id,caption,permalink,timestamp,username,media_type,media_url,thumbnail_url,'
  + 'children{id,media_type,media_url,thumbnail_url}';
const LOOKBACK_DAYS = 14;
const BACKFILL_DAYS = 365;          // first run only (no ig_tag rows yet), so older tags get picked up once
const TIME_BUDGET_MS = 20000;       // scheduled functions get 30s; leave room for the kick + health row
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 3_300_000;  // same cap social-intake applies to a screenshot
const DOWNLOAD_TIMEOUT_MS = 8000;
const MEDIA_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

exports.handler = async () => {
  const r = await runCollector();
  return { statusCode: r.httpStatus };
};

// One collector run. The schedule calls it with the defaults. meta-graph-health's
// 'collect' test calls it on a deploy preview (scheduled functions don't run
// there) with a shorter budget, since that function has a ~10s limit.
// Returns { status, summary, httpStatus }; never throws.
async function runCollector({ budgetMs = TIME_BUDGET_MS, maxPages = null, trigger = 'schedule' } = {}) {
  const db = P.getDb();
  if (!db) { console.error('[ig-tags] SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); return { status: 'error', error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set', httpStatus: 503 }; }
  const igUserId = process.env.IG_USER_ID;
  if (!igUserId) {
    await G.recordHealth(db, 'error', 'IG_USER_ID not set', INTEGRATION);
    return { status: 'error', error: 'IG_USER_ID not set', httpStatus: 500 };
  }

  const started = Date.now();
  const summary = { trigger, fetched: 0, pages: 0, inserted: 0, caption_only: 0, images: 0, linked_existing: 0, duplicate: 0, failed: 0, deferred: 0 };
  try {
    const result = await collect(db, igUserId, started, summary, { budgetMs, maxPages });
    Object.assign(summary, result);
    if (summary.inserted) {
      const kicked = await P.kickStage(P.siteBase(), 'prefilter-social-posts-background', {});
      summary.pipeline_kicked = kicked;   // false is fine: the hourly sweep kicks it
    }
    await G.recordHealth(db, 'ok', { new: summary.inserted, ...summary }, INTEGRATION);
    console.log('[ig-tags]', JSON.stringify(summary));
    return { status: 'ok', summary, httpStatus: 200 };
  } catch (err) {
    const status = G.healthStatusFor(err);
    const message = G.scrub(err.message);
    console.error(`[ig-tags] run stopped (${status}):`, message);
    await G.recordHealth(db, status, { message, code: err.code ?? null, ...summary }, INTEGRATION);
    return { status, error: message, code: err.code ?? null, summary, httpStatus: status === 'rate_limited' ? 200 : 500 };
  }
}

async function collect(db, igUserId, started, summary, { budgetMs = TIME_BUDGET_MS, maxPages = null } = {}) {
  // Backfill mode until one run has walked the whole lookback and stored every
  // post. A cut-short first run must not drop to the 14-day window, or the older
  // posts it didn't reach (e.g. August's WCHE tags) would never be collected.
  // In backfill mode posts we already have are skipped rather than ending the walk.
  const { error: tableErr } = await db.from('social_posts').select('id', { count: 'exact', head: true }).eq('ingest_method', 'ig_tag');
  if (tableErr) throw new Error(`social_posts not readable (run the IG ingest migration?): ${tableErr.message}`);
  const { data: doneRows } = await db.from('integration_health').select('id')
    .eq('integration', INTEGRATION).eq('status', 'ok').ilike('detail', '%"backfill_complete":true%').limit(1);
  const backfill = !(doneRows && doneRows.length);
  const cutoff = Date.now() - (backfill ? BACKFILL_DAYS : LOOKBACK_DAYS) * 86_400_000;

  // Look up a whole page of ids at once the first time stopWhen sees that page.
  const known = new Set();
  const lookedUp = new WeakSet();
  const stopWhen = async (item, page) => {
    if (!lookedUp.has(page)) {
      lookedUp.add(page);
      const ids = page.map(i => i?.id).filter(Boolean);
      if (ids.length) {
        const { data, error } = await db.from('social_posts').select('ig_media_id').in('ig_media_id', ids);
        if (error) throw new Error(`ig_media_id lookup failed: ${error.message}`);
        for (const r of data || []) known.add(r.ig_media_id);
      }
    }
    if (!item?.id) return true;
    if (!backfill && known.has(item.id)) return true;
    const ts = Date.parse(item.timestamp);
    return Number.isFinite(ts) && ts < cutoff;
  };

  const walkStarted = Date.now();
  const walk = await G.graphPaginate(`${igUserId}/tags`,
    { fields: FIELDS, limit: 50 }, { stopWhen, maxPages: maxPages || (backfill ? 20 : 5) });
  const items = walk.items.filter(i => !known.has(i.id));
  const truncated = !!walk.truncated;
  summary.fetched = walk.items.length;
  summary.pages = walk.pages;
  summary.walk_ms = Date.now() - walkStarted;

  // Oldest first: if the run is cut short, what's left is the newest posts,
  // which the next run still reaches before it hits one we already have.
  const ordered = items.slice().sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  for (let i = 0; i < ordered.length; i++) {
    // Always store at least one post per run, so a slow Instagram read can't use
    // the whole budget every time and leave a run that never makes progress.
    if (i > 0 && Date.now() - started > budgetMs) { summary.deferred = ordered.length - i; break; }
    try {
      const r = await ingestItem(db, ordered[i]);
      summary[r.result]++;
      summary.images += r.images || 0;
      if (r.result === 'inserted' && !r.images) summary.caption_only++;
    } catch (err) {
      summary.failed++;
      console.error(`[ig-tags] media ${ordered[i].id} failed:`, G.scrub(err.message));
    }
  }
  return {
    backfill,
    truncated,
    // Set once: later runs use the 14-day window and stop at the first known post.
    backfill_complete: !backfill || (!summary.deferred && !truncated && !summary.failed),
  };
}

async function ingestItem(db, item) {
  const permalink = P.norm(item.permalink) || null;
  const parsed = permalink ? P.parsePostUrl(permalink) : null;
  // Same key manual intake gives a pasted link to this post, so the two paths dedupe.
  const postKey = parsed?.platform === 'instagram'
    ? P.postKeyFor('instagram', parsed.platformPostId)
    : P.postKeyFor('instagram', `media:${item.id}`);
  const postedAt = Number.isFinite(Date.parse(item.timestamp)) ? new Date(item.timestamp).toISOString() : null;
  const igFields = {
    ig_media_id: item.id,
    permalink,
    media_type: item.media_type || null,
    poster_username: P.norm(item.username) || null,
    poster_consented: true,
  };

  // Draft first: no pipeline stage claims a draft, so extraction can't start
  // before the images are stored. A run that dies here leaves a draft that the
  // hourly sweep deletes, and the next run collects the post again.
  const { data: row, error } = await db.from('social_posts').insert({
    post_key: postKey,
    platform: 'instagram',
    post_url: permalink,
    ingest_method: 'ig_tag',
    caption_clean: P.cleanCaption(item.caption) || null,
    posted_at: postedAt,
    status: 'draft',
    ...igFields,
  }).select('id').single();

  if (error) {
    if (error.code !== '23505') throw new Error(`insert failed: ${error.message}`);
    // Already in v2 under the same link (e.g. pasted into manual intake).
    // Attach the Instagram id so later runs stop here.
    const { data: existing } = await db.from('social_posts').select('id, ig_media_id').eq('post_key', postKey).maybeSingle();
    if (existing && !existing.ig_media_id) {
      await db.from('social_posts').update({ ...igFields, updated_at: new Date().toISOString() }).eq('id', existing.id);
      return { result: 'linked_existing' };
    }
    return { result: 'duplicate' };
  }

  let stored = 0;
  for (const url of mediaCandidates(item)) {
    if (stored >= MAX_IMAGES) break;
    try {
      if (await storeImage(db, row.id, stored, url)) stored++;
    } catch (err) {
      console.warn(`[ig-tags] media ${item.id}: image skipped:`, G.scrub(err.message));
    }
  }

  const { error: upErr } = await db.from('social_posts')
    .update({ status: 'pending_filter', updated_at: new Date().toISOString() }).eq('id', row.id);
  if (upErr) throw new Error(`queue failed: ${upErr.message}`);
  return { result: 'inserted', images: stored };
}

// Image URLs for a post: each image (a video contributes its thumbnail).
function mediaCandidates(item) {
  const one = (m) => (m?.media_type === 'VIDEO' ? m.thumbnail_url : m?.media_url) || null;
  if (item.media_type === 'CAROUSEL_ALBUM' && Array.isArray(item.children?.data)) {
    return item.children.data.map(one).filter(Boolean);
  }
  const u = one(item);
  return u ? [u] : [];
}

function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// Download one image and store it as social_post_media row `index`.
// Returns false when it was skipped (bad host/type/size, or an image already
// stored for another post).
async function storeImage(db, postId, index, url) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { return false; }
  if (!MEDIA_HOST_RE.test(host)) { console.warn(`[ig-tags] unexpected media host ${host}, skipped`); return false; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let buf;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    if (len && len > MAX_IMAGE_BYTES) return false;
    buf = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  if (buf.length > MAX_IMAGE_BYTES) return false;
  const mediaType = sniffImageType(buf);
  if (!mediaType) return false;

  const hash = P.sha256(buf);
  const { data: seen } = await db.from('social_post_media').select('post_id').eq('sha256', hash).maybeSingle();
  if (seen) return false;

  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const path = `${postId}/${index}.${ext}`;
  const { error: upErr } = await db.storage.from(P.EVIDENCE_BUCKET).upload(path, buf, { contentType: mediaType, upsert: true });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);
  const { error } = await db.from('social_post_media').insert({
    post_id: postId, image_index: index, storage_path: path, media_type: mediaType, sha256: hash,
  });
  if (error) {
    await db.storage.from(P.EVIDENCE_BUCKET).remove([path]);
    if (error.code === '23505') return false;
    throw new Error(`media row failed: ${error.message}`);
  }
  return true;
}

// Exported for tests.
exports.runCollector = runCollector;
exports._internal = { ingestItem, mediaCandidates, sniffImageType, collect, FIELDS };
