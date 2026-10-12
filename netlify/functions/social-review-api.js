// social-review-api.js — admin review queue for Social Sale Ingestion (§9).
// Admin only (Supabase JWT + admins table); all reads/writes use the service key.
//
// POST { action, ... }
//   queue      { status?='review', limit?, offset? }  → rows + post + signed image URLs + counts
//   posts      { limit? }                             → recent intake posts and their status
//   approve    { id, fields, offfloor?, force? }      → writes social_sales (merges same-cert ±3d);
//                                                      no show picked → approved_offfloor
//   reject     { id, reason }
//   duplicate  { id, sale_id }
//   reverify   { id, fields? }                        → back to pending_verify (e.g. after fixing a cert digit)
//   find_sales { grader, cert_number }                → candidate sales for "Duplicate of…"
//   shows      {}                                     → every show (id, name, date) for the show picker
//   report     {}                                     → precision by price source and grader, gate status, budget
//   hashtags   { op: 'list'|'add'|'remove', ... }     → show_hashtags registry (§2A)
//   watchlist  { op: 'list'|'add'|'remove', ... }     → social_watchlist (§2)

const P = require('../lib/social-pipeline');

const EDITABLE = ['grader', 'cert_number', 'grade', 'grade_label', 'year', 'card_set', 'card_number',
  'player', 'parallel', 'category', 'subcategory', 'sold_price', 'sold_price_source', 'asking_price',
  'asking_price_basis', 'show_id', 'sold_date'];
const NUMERIC = ['sold_price', 'asking_price'];
const TITLE_PARTS = ['year', 'card_set', 'player', 'parallel', 'card_number', 'category'];
const LATER_STAGE_REASONS = /^(cert_card_mismatch|field_mismatch:|cert_not_found|cert_unreadable|stolen_report|outside_comp_band:|show_unattributed|show_ambiguous|possible_duplicate|conflicting_price)/;

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
      case 'queue':      return await queue(db, input);
      case 'posts':      return await posts(db, input);
      case 'approve':    return await approve(db, admin, input);
      case 'reject':     return await reject(db, admin, input);
      case 'duplicate':  return await duplicate(db, admin, input);
      case 'reverify':   return await reverify(db, event, input);
      case 'find_sales': return await findSales(db, input);
      case 'shows':      return await listShows(db);
      case 'report':     return await report(db);
      case 'hashtags':   return await hashtags(db, input);
      case 'watchlist':  return await watchlist(db, input);
      default:           return P.json(400, { success: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error('[social-review-api]', err);
    return P.json(500, { success: false, error: 'internal_error', message: err.message });
  }
};

async function signedMedia(db, postIds) {
  if (!postIds.length) return {};
  const { data: media } = await db.from('social_post_media')
    .select('post_id, image_index, storage_path, purged_at').in('post_id', postIds).order('image_index');
  const live = (media || []).filter(m => !m.purged_at);
  const out = {};
  if (live.length) {
    const { data: signed } = await db.storage.from(P.EVIDENCE_BUCKET).createSignedUrls(live.map(m => m.storage_path), 3600);
    live.forEach((m, i) => {
      (out[m.post_id] = out[m.post_id] || []).push({ index: m.image_index, url: signed?.[i]?.signedUrl || null });
    });
  }
  return out;
}

async function queue(db, input) {
  const status = input.status || 'review';
  const limit = Math.min(Number(input.limit) || 50, 100);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const { data: rows, error } = await db.from('social_extractions')
    .select('*').eq('status', status).order('created_at').range(offset, offset + limit - 1);
  if (error) throw error;

  const postIds = [...new Set((rows || []).map(r => r.post_id))];
  const { data: postRows } = postIds.length
    ? await db.from('social_posts').select('id, platform, post_url, ingest_method, source_hashtag, caption_clean, posted_at, created_at, extraction_raw').in('id', postIds)
    : { data: [] };
  const media = await signedMedia(db, postIds);
  const postsById = Object.fromEntries((postRows || []).map(p => [p.id, {
    ...p,
    notes: p.extraction_raw?.notes || null,
    show_hints: p.extraction_raw?.show_hints || [],
    extraction_raw: undefined,
    images: media[p.id] || [],
  }]));

  const counts = {};
  for (const s of ['pending_verify', 'pending_resolve', 'review']) {
    const { count } = await db.from('social_extractions').select('id', { count: 'exact', head: true }).eq('status', s);
    counts[s] = count || 0;
  }
  return P.json(200, { success: true, rows: (rows || []).map(r => ({ ...r, post: postsById[r.post_id] || null })), counts });
}

async function posts(db, input) {
  const limit = Math.min(Number(input.limit) || 30, 100);
  const { data, error } = await db.from('social_posts')
    .select('id, platform, post_url, ingest_method, caption_clean, posted_at, status, reject_reason, filter_stage, filter_reason, error, created_at, distinct_slab_count')
    .neq('status', 'draft').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return P.json(200, { success: true, posts: data || [] });
}

async function loadReviewable(db, id) {
  const { data: ext } = await db.from('social_extractions').select('*').eq('id', id).maybeSingle();
  if (!ext) return { error: P.json(404, { success: false, error: 'not_found' }) };
  if (ext.status !== 'review') return { error: P.json(409, { success: false, error: 'not_in_review', status: ext.status }) };
  return { ext };
}

function coerce(field, value) {
  if (NUMERIC.includes(field)) return P.numOrNull(value);
  const s = P.norm(value);
  if (field === 'grader') return s.toUpperCase() || null;
  if (field === 'grade') return P.normalizeGrade(s);
  if (field === 'year') return P.normalizeYear(s);
  if (field === 'cert_number') return s.replace(/\s+/g, '').toUpperCase() || null;
  return s || null;
}

// Apply reviewer edits; returns { next, edits, editedFields }.
function applyEdits(ext, fields = {}) {
  const next = { ...ext };
  const edits = {}, editedFields = [];
  for (const f of EDITABLE) {
    if (!(f in fields)) continue;
    const v = coerce(f, fields[f]);
    const before = ext[f] ?? null;
    const changed = NUMERIC.includes(f) ? Number(before) !== Number(v) || (before === null) !== (v === null) : String(before ?? '') !== String(v ?? '');
    if (changed) { edits[f] = { from: before, to: v }; editedFields.push(f); next[f] = v; }
  }
  // Provenance follows the edit.
  if (editedFields.includes('sold_price') && !editedFields.includes('sold_price_source')) next.sold_price_source = 'reviewer';
  if (editedFields.includes('asking_price') && !editedFields.includes('asking_price_basis')) next.asking_price_basis = 'reviewer';
  // The DB rejects an assumed_equal_sold asking price that differs from sold.
  if (next.asking_price_basis === 'assumed_equal_sold') next.asking_price = next.sold_price;
  if (editedFields.some(f => f === 'category' || f === 'subcategory')) {
    Object.assign(next, P.resolveCategory(next.category, next.subcategory));
  }
  if (editedFields.some(f => TITLE_PARTS.includes(f))) next.card_title = P.buildCardTitle(next);
  if (editedFields.includes('show_id')) next.show_match_method = next.show_id ? 'reviewer' : 'unattributed';
  if (editedFields.includes('sold_date')) next.sold_date_basis = 'reviewer';
  return { next, edits, editedFields };
}

async function approve(db, admin, input) {
  const { ext, error } = await loadReviewable(db, input.id);
  if (error) return error;
  const { next, edits, editedFields } = applyEdits(ext, input.fields);

  if (!P.GRADERS.includes(next.grader)) return P.json(400, { success: false, error: 'bad_grader' });
  if (next.cert_number && !P.normalizeCert(next.grader, next.cert_number)) {
    return P.json(400, { success: false, error: 'bad_cert_format', message: 'Fix the cert number (no "?" digits) or clear it.' });
  }
  if (!(next.sold_price > 0)) return P.json(400, { success: false, error: 'sold_price_required' });
  if (!(next.asking_price > 0)) return P.json(400, { success: false, error: 'asking_price_required' });
  if (!next.sold_date || !/^\d{4}-\d{2}-\d{2}$/.test(next.sold_date)) return P.json(400, { success: false, error: 'sold_date_required' });
  // No show attributed (e.g. a general-tag post with only a date match) →
  // still a valid graded comp, kept out of show-floor data.
  const offfloor = !!input.offfloor || !next.show_id;
  if (next.asking_price_basis === 'sticker' && next.sold_price > next.asking_price && !input.force) {
    return P.json(409, { success: false, error: 'sold_above_sticker', message: 'Sold price is above the sticker. Approve anyway?' });
  }

  const pub = await P.publishExtraction(db, next, { method: 'reviewer', onFloor: !offfloor, force: !!input.force });
  if (pub.conflict) return P.json(409, { success: false, error: 'conflicting_price', existing: pub.existing });

  const patch = {
    status: pub.merged ? 'duplicate' : (offfloor ? 'approved_offfloor' : 'approved'),
    social_sale_id: pub.saleId,
    duplicate_of: pub.merged ? pub.saleId : null,
    review_edits: Object.keys(edits).length ? edits : null,
    edited_fields: editedFields,
    reviewed_by: admin.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  for (const f of EDITABLE) if (editedFields.includes(f)) patch[f] = next[f];
  for (const f of ['sold_price_source', 'asking_price', 'asking_price_basis', 'show_match_method', 'sold_date_basis',
                   'card_title', 'category', 'subcategory']) patch[f] = next[f];
  await db.from('social_extractions').update(patch).eq('id', ext.id);
  await P.maybeSchedulePurge(db, ext.post_id);

  const { data: post } = await db.from('social_posts').select('source_hashtag').eq('id', ext.post_id).maybeSingle();
  if (post?.source_hashtag) await P.bumpYield(db, post.source_hashtag, { approved: 1, approved_on_floor: offfloor ? 0 : 1 });
  return P.json(200, { success: true, sale_id: pub.saleId, merged: pub.merged, offfloor });
}

async function reject(db, admin, input) {
  const { ext, error } = await loadReviewable(db, input.id);
  if (error) return error;
  const reason = P.norm(input.reason) || 'reviewer_rejected';
  await db.from('social_extractions').update({
    status: 'rejected', reject_reason: reason.slice(0, 200), edited_fields: [],
    reviewed_by: admin.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', ext.id);
  await P.maybeSchedulePurge(db, ext.post_id);
  return P.json(200, { success: true });
}

async function duplicate(db, admin, input) {
  const { ext, error } = await loadReviewable(db, input.id);
  if (error) return error;
  const { data: sale } = await db.from('social_sales').select('id, corroboration_count').eq('id', input.sale_id).maybeSingle();
  if (!sale) return P.json(404, { success: false, error: 'sale_not_found' });
  await db.from('social_sales').update({ corroboration_count: sale.corroboration_count + 1, updated_at: new Date().toISOString() }).eq('id', sale.id);
  await db.from('social_extractions').update({
    status: 'duplicate', duplicate_of: sale.id, social_sale_id: sale.id, edited_fields: [],
    reviewed_by: admin.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', ext.id);
  await P.maybeSchedulePurge(db, ext.post_id);
  return P.json(200, { success: true });
}

async function reverify(db, event, input) {
  const { ext, error } = await loadReviewable(db, input.id);
  if (error) return error;
  const fields = {};
  if (input.fields?.grader) fields.grader = coerce('grader', input.fields.grader);
  if (input.fields && 'cert_number' in input.fields) {
    fields.cert_number = coerce('cert_number', input.fields.cert_number);
    fields.cert_recovered = false;
  }
  const grader = fields.grader || ext.grader;
  if (fields.cert_number && !P.normalizeCert(grader, fields.cert_number)) {
    return P.json(400, { success: false, error: 'bad_cert_format' });
  }
  await db.from('social_extractions').update({
    ...fields,
    status: 'pending_verify', verify_status: 'pending', verified_cert: null, card_match_score: null,
    claimed_at: null,
    route_reasons: (ext.route_reasons || []).filter(r => !LATER_STAGE_REASONS.test(r)),
    updated_at: new Date().toISOString(),
  }).eq('id', ext.id);
  await P.kickStage(P.siteBase(event), 'verify-certs-background', { post_id: ext.post_id });
  return P.json(200, { success: true });
}

async function findSales(db, input) {
  let q = db.from('social_sales').select('id, grader, cert_number, player, year, card_set, grade, sold_price, sold_date, show_id, corroboration_count')
    .order('sold_date', { ascending: false }).limit(20);
  if (input.cert_number) q = q.eq('cert_number', P.norm(input.cert_number).toUpperCase());
  if (input.grader) q = q.eq('grader', P.norm(input.grader).toUpperCase());
  const { data, error } = await q;
  if (error) throw error;
  return P.json(200, { success: true, sales: data || [] });
}

async function listShows(db) {
  const { data, error } = await db.from('shows').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return P.json(200, { success: true, shows: (data || []).map(s => ({
    id: s.id, name: s.name, date: s.date, start_date: s.start_date || null, end_date: s.end_date || null,
  })) });
}

async function report(db) {
  const { data: reviewed, error } = await db.from('social_extractions')
    .select('status, grader, sold_price_source, edited_fields, auto_eligible')
    .not('reviewed_at', 'is', null).limit(10000);
  if (error) throw error;

  const bucket = () => ({ reviewed: 0, approved: 0, clean: 0, rejected: 0, duplicate: 0 });
  const bySource = {}, byGrader = {}, auto = bucket();
  for (const r of reviewed || []) {
    const isApproved = ['approved', 'approved_offfloor', 'duplicate'].includes(r.status);
    const isClean = isApproved && !(r.edited_fields || []).some(f => P.CRITICAL_FIELDS.includes(f));
    for (const b of [
      bySource[r.sold_price_source || 'none'] = bySource[r.sold_price_source || 'none'] || bucket(),
      byGrader[r.grader || 'none'] = byGrader[r.grader || 'none'] || bucket(),
      ...(r.auto_eligible ? [auto] : []),
    ]) {
      b.reviewed++;
      if (isApproved) b.approved++;
      if (isClean) b.clean++;
      if (r.status === 'rejected') b.rejected++;
      if (r.status === 'duplicate') b.duplicate++;
    }
  }
  const withPrecision = (o) => Object.fromEntries(Object.entries(o).map(([k, b]) => [k, { ...b, precision: b.reviewed ? Math.round((b.clean / b.reviewed) * 1000) / 1000 : null }]));

  const postCounts = {};
  for (const s of ['pending_filter', 'queued', 'extracting', 'extracted', 'multi_card', 'no_slab', 'filtered_out', 'rejected', 'failed']) {
    const { count } = await db.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', s);
    postCounts[s] = count || 0;
  }
  const extCounts = {};
  for (const s of ['pending_verify', 'pending_resolve', 'review', 'auto_approved', 'approved', 'approved_offfloor', 'rejected', 'duplicate']) {
    const { count } = await db.from('social_extractions').select('id', { count: 'exact', head: true }).eq('status', s);
    extCounts[s] = count || 0;
  }
  const { data: budget } = await db.from('api_budget').select('*').eq('day', P.isoDate(new Date()));
  const { count: salesCount } = await db.from('social_sales').select('id', { count: 'exact', head: true });

  return P.json(200, {
    success: true,
    by_price_source: withPrecision(bySource),
    by_grader: withPrecision(byGrader),
    auto_pattern: withPrecision({ auto }).auto,
    gate: await P.autoApproveGate(db),
    posts: postCounts,
    extractions: extCounts,
    social_sales: salesCount || 0,
    budget: budget || [],
  });
}

async function hashtags(db, input) {
  const op = input.op || 'list';
  if (op === 'add') {
    const tag = P.lc(input.tag).replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    if (!tag) return P.json(400, { success: false, error: 'tag_required' });
    const tier = input.show_id ? 'show' : 'general';
    const row = { tag, tier, show_id: input.show_id || null, official: !!input.official,
      poll_minutes: Number(input.poll_minutes) || (tier === 'show' ? 60 : 120) };
    if (tier === 'show') {
      const { data: show } = await db.from('shows').select('*').eq('id', input.show_id).maybeSingle();
      if (!show) return P.json(404, { success: false, error: 'show_not_found' });
      const range = P.showRange(show);
      if (range) {
        row.active_from  = P.isoDate(P.addDays(range.start, -1));
        row.active_until = P.isoDate(P.addDays(range.end, 2));
      }
    }
    const { error } = await db.from('show_hashtags').insert(row);
    if (error) return P.json(error.code === '23505' ? 409 : 500, { success: false, error: error.code === '23505' ? 'duplicate_tag' : error.message });
  } else if (op === 'remove') {
    await db.from('show_hashtags').delete().eq('id', input.id);
  }
  const { data } = await db.from('show_hashtags').select('*').order('tier').order('tag');
  return P.json(200, { success: true, hashtags: data || [] });
}

async function watchlist(db, input) {
  const op = input.op || 'list';
  if (op === 'add') {
    const platform = ['instagram', 'x'].includes(input.platform) ? input.platform : null;
    const account = P.lc(input.account).replace(/^@/, '');
    if (!platform || !account) return P.json(400, { success: false, error: 'platform_and_account_required' });
    const { error } = await db.from('social_watchlist').insert({ platform, account, notes: P.norm(input.notes) || null });
    if (error) return P.json(error.code === '23505' ? 409 : 500, { success: false, error: error.code === '23505' ? 'duplicate_account' : error.message });
  } else if (op === 'remove') {
    await db.from('social_watchlist').delete().eq('id', input.id);
  }
  const { data } = await db.from('social_watchlist').select('*').order('platform').order('account');
  return P.json(200, { success: true, watchlist: data || [] });
}
