// resolve-and-route-background.js — Social Sale Ingestion, stage 3 (§5–§8).
// Netlify background function.
//
// POST { post_id? } with x-social-pipeline-secret. For each claimed
// 'pending_resolve' extraction: comp sanity band, show attribution, sale date,
// duplicate check, confidence score. Then either auto-approves (only the §8
// pattern, only once the D5 precision gate is open) or sends it to review.

const P = require('../lib/social-pipeline');

const BATCH = 50;

exports.handler = async (event) => {
  if (!P.isPipelineCall(event)) return { statusCode: 401 };
  const db = P.getDb();
  if (!db) return { statusCode: 503 };
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { /* empty */ }
  const base = input.base || P.siteBase(event);

  const { data: rows, error } = await db.rpc('claim_social_extractions', {
    p_status: 'pending_resolve', p_limit: BATCH, p_post_id: input.post_id || null,
  });
  if (error) { console.error('[social-resolve] claim failed:', error.message); return { statusCode: 500 }; }
  if (!rows?.length) return { statusCode: 202 };

  const ctx = {
    base,
    shows: await loadShows(db),
    hashtags: (await db.from('show_hashtags').select('show_id, tag, tier').eq('active', true)).data || [],
    gate: await P.autoApproveGate(db),
    posts: {},
  };

  for (const ext of rows) {
    try {
      await resolveOne(db, ext, ctx);
    } catch (err) {
      console.error(`[social-resolve] ${ext.id} failed:`, err.message);
      await db.from('social_extractions').update({ claimed_at: null, updated_at: new Date().toISOString() }).eq('id', ext.id);
    }
  }
  if (!input.post_id && rows.length === BATCH) await P.kickStage(base, 'resolve-and-route-background', {});
  return { statusCode: 202 };
};

async function loadShows(db) {
  const { data, error } = await db.from('shows').select('*');
  if (error) { console.warn('[social-resolve] shows load failed:', error.message); return []; }
  return data || [];
}

async function loadPost(db, ctx, postId) {
  if (!ctx.posts[postId]) {
    const { data } = await db.from('social_posts')
      .select('id, caption_clean, posted_at, created_at, hint_show_id, source_hashtag, extraction_raw')
      .eq('id', postId).maybeSingle();
    ctx.posts[postId] = data;
  }
  return ctx.posts[postId];
}

async function resolveOne(db, ext, ctx) {
  const post = await loadPost(db, ctx, ext.post_id);
  const reasons = [...(ext.route_reasons || [])];
  const postedAt = new Date(post?.posted_at || post?.created_at || Date.now());

  // Comp sanity band (force review, never reject: off-market floor deals are the point).
  const median = await P.compMedian(ctx.base, ext);
  const sanity = P.sanityFlag(ext.sold_price, median);
  if (sanity === 'low' || sanity === 'high') reasons.push(`outside_comp_band:${sanity}`);

  // Show attribution. A show the submitter picked wins.
  let show = null, method = 'unattributed', showScore = 0;
  const hintShow = post?.hint_show_id ? ctx.shows.find(s => s.id === post.hint_show_id) : null;
  if (hintShow) {
    show = hintShow; method = 'submitter'; showScore = 1;
  } else {
    const a = P.attributeShow({
      shows: ctx.shows, hashtags: ctx.hashtags, caption: post?.caption_clean,
      showHints: post?.extraction_raw?.show_hints, postedAt, sourceHashtag: post?.source_hashtag,
    });
    method = a.method; showScore = a.score || 0;
    show = a.showId ? ctx.shows.find(s => s.id === a.showId) : null;
  }
  if (!show) reasons.push(method === 'ambiguous' ? 'show_ambiguous' : 'show_unattributed');

  const sold = P.resolveSoldDate({
    dateHints: post?.extraction_raw?.sale_date_hints, caption: post?.caption_clean, postedAt, show,
  });

  // Same cert sold within ±3 days already on file?
  const existing = await P.findSameSale(db, ext.grader, ext.cert_number, sold.date);
  if (existing) reasons.push(P.samePrice(ext.sold_price, existing.sold_price) ? 'possible_duplicate' : 'conflicting_price');

  const resolved = {
    ...ext,
    comp_median: median,
    sanity_flag: sanity,
    show_id: show?.id || null,
    show_match_method: show ? method : method === 'ambiguous' ? 'ambiguous' : 'unattributed',
    show_score: showScore,
    sold_date: sold.date,
    sold_date_basis: sold.basis,
  };
  resolved.cert_score  = P.certScore(ext.verify_status);
  resolved.price_score = P.PRICE_SCORE[ext.sold_price_source] ?? 0;
  resolved.confidence  = P.overallScore({
    certScore: resolved.cert_score, cardMatch: ext.card_match_score,
    priceScore: resolved.price_score, showScore, corroborated: !!existing && P.samePrice(ext.sold_price, existing.sold_price),
  });
  // auto_eligible ignores a same-price duplicate (it merges cleanly); every
  // other route reason disqualifies.
  const blocking = reasons.filter(r => r !== 'possible_duplicate');
  resolved.route_reasons = blocking;
  resolved.auto_eligible = P.isAutoEligible(resolved);
  resolved.route_reasons = [...new Set(reasons)];

  const patch = {
    comp_median: resolved.comp_median, sanity_flag: resolved.sanity_flag,
    show_id: resolved.show_id, show_match_method: resolved.show_match_method, show_score: resolved.show_score,
    sold_date: resolved.sold_date, sold_date_basis: resolved.sold_date_basis,
    cert_score: resolved.cert_score, price_score: resolved.price_score, confidence: resolved.confidence,
    auto_eligible: resolved.auto_eligible, route_reasons: resolved.route_reasons,
    duplicate_of: existing?.id || null,
    claimed_at: null, updated_at: new Date().toISOString(),
  };

  if (resolved.auto_eligible && ctx.gate.open && resolved.sold_date) {
    const pub = await P.publishExtraction(db, resolved, { method: 'auto', onFloor: true });
    if (!pub.conflict) {
      Object.assign(patch, {
        status: pub.merged ? 'duplicate' : 'auto_approved',
        social_sale_id: pub.saleId,
        duplicate_of: pub.merged ? pub.saleId : null,
      });
      await db.from('social_extractions').update(patch).eq('id', ext.id);
      await P.maybeSchedulePurge(db, ext.post_id);
      if (post?.source_hashtag) await P.bumpYield(db, post.source_hashtag, { approved: 1, approved_on_floor: 1 });
      return;
    }
    patch.route_reasons = [...new Set([...patch.route_reasons, 'conflicting_price'])];
  }

  patch.status = 'review';
  await db.from('social_extractions').update(patch).eq('id', ext.id);
}
