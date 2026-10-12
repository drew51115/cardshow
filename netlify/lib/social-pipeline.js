// social-pipeline.js — shared logic for Social Sale Ingestion (graded cards).
// See "Social Sale Ingestion" in CLAUDE.md and the v1 build spec.
//
// Lives outside netlify/functions/ so Netlify doesn't treat it as a function;
// each social-* function requires it and the bundler pulls it in. Every stage
// is status-driven and idempotent:
//
//   social_posts.status        draft → [pending_filter →] queued → extracting → extracted
//                                       ↘ filtered_out         ↘ multi_card | no_slab | rejected | failed
//   social_extractions.status  pending_verify → pending_resolve → review | auto_approved
//                                  ↘ rejected                      → approved | approved_offfloor
//                                                                     | rejected | duplicate
//
// Stages hand off to each other by POSTing to the next background function
// with the x-social-pipeline-secret header (kickStage). The hourly sweep
// (social-pipeline-sweep.js) re-kicks anything left behind.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Anthropic } = require('@anthropic-ai/sdk');

// ── Config ───────────────────────────────────────────────────────────────────
const EXTRACT_MODEL   = 'claude-opus-5-5';
const TRIAGE_MODEL    = 'claude-haiku-5-5';   // spec §2A stage 3: small, fast model
const EVIDENCE_BUCKET = 'social-evidence';
const RETENTION_DAYS  = Number(process.env.SOCIAL_EVIDENCE_RETENTION_DAYS || 30);
const PSA_DAILY_LIMIT = Number(process.env.SOCIAL_PSA_DAILY_LIMIT || 80); // PSA free tier is 100/day; leave headroom
const AUTO_APPROVE_MIN_REVIEWED = 200;
const AUTO_APPROVE_MIN_PRECISION = 0.98;
const SANITY_LOW = 0.4, SANITY_HIGH = 2.5;
const DEDUP_DAYS = 3;
const GRADERS = ['PSA', 'BGS', 'SGC', 'CGC', 'TAG'];

// Cert formats per grader. Starting values — validate against real slabs
// before go-live (spec §3). A cert that fails its format is nulled and only
// the partial read is kept.
const CERT_FORMATS = {
  PSA: /^\d{7,10}$/,
  BGS: /^\d{7,10}$/,
  SGC: /^\d{7,10}$/,
  CGC: /^\d{7,10}$/,
  TAG: /^[A-Z0-9]{6,12}$/,
};

const PIPELINE_SECRET_HEADER = 'x-social-pipeline-secret';

// ── Small helpers ────────────────────────────────────────────────────────────
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function getDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const norm = (s) => String(s ?? '').trim();
const lc   = (s) => norm(s).toLowerCase();
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isoDate = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Grades are stored as normalized text ('10', '9.5'): the same rendering
// show_floor_transactions' numeric grade gets, so card_fingerprint matches.
function normalizeGrade(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? String(n) : null;
}

// The app stores show_floor_transactions.year as parseInt(Year), so "2018-19"
// becomes 2018. Same here, or the fingerprints won't line up.
function normalizeYear(v) {
  const m = String(v ?? '').match(/(?:19|20)\d{2}/);
  return m ? m[0] : null;
}

// Same vocabulary as CATEGORY_SUBCATEGORIES in app.html (duplicated: no
// shared module between the page and the functions).
const CATEGORY_SUBCATEGORIES = {
  'Sports': ['Baseball', 'Basketball', 'Football', 'Hockey', 'Soccer', 'Golf', 'Boxing', 'MMA/UFC', 'Wrestling', 'Racing/Motorsports', 'Tennis', 'Other Sport'],
  'TCG': ['Pokémon', 'Magic: The Gathering', 'Yu-Gi-Oh!', 'One Piece Card Game', 'Disney Lorcana', 'Digimon Card Game', 'Dragon Ball Super Fusion World', 'Gundam Card Game', 'Flesh and Blood', 'Star Wars Unlimited', 'Weiss Schwarz', 'Union Arena', 'Other TCG'],
  'Non-Sport': ['Marvel', 'Star Wars', 'Disney', 'DC', 'Star Trek', 'Other Non-Sport'],
};

// PSA's Category field ("BASEBALL CARDS", "TCG CARDS", "POKEMON CARDS"…) → taxonomy.
const PSA_CATEGORY_HINTS = [
  [/baseball/i, 'Sports', 'Baseball'], [/basketball/i, 'Sports', 'Basketball'],
  [/football/i, 'Sports', 'Football'], [/hockey/i, 'Sports', 'Hockey'],
  [/soccer/i, 'Sports', 'Soccer'], [/golf/i, 'Sports', 'Golf'], [/boxing/i, 'Sports', 'Boxing'],
  [/\bufc\b|\bmma\b/i, 'Sports', 'MMA/UFC'], [/wrestl/i, 'Sports', 'Wrestling'],
  [/racing|nascar|formula/i, 'Sports', 'Racing/Motorsports'], [/tennis/i, 'Sports', 'Tennis'],
  [/pok[eé]mon/i, 'TCG', 'Pokémon'], [/magic/i, 'TCG', 'Magic: The Gathering'],
  [/yu-?gi-?oh/i, 'TCG', 'Yu-Gi-Oh!'], [/one piece/i, 'TCG', 'One Piece Card Game'],
  [/lorcana/i, 'TCG', 'Disney Lorcana'], [/tcg/i, 'TCG', null],
  [/marvel/i, 'Non-Sport', 'Marvel'], [/star wars/i, 'Non-Sport', 'Star Wars'],
  [/non-?sport/i, 'Non-Sport', null],
];

// Validate a category/subcategory pair against the vocabulary. A known
// subcategory implies its category; an unknown one is kept only with a
// valid category (the app's "Other …" free-text path does the same).
const foldKey = (s) => lc(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
function resolveCategory(category, subcategory) {
  const cats = Object.keys(CATEGORY_SUBCATEGORIES);
  let cat = cats.find(c => foldKey(c) === foldKey(category)) || null;
  const subRaw = norm(subcategory);
  let sub = null;
  if (subRaw) {
    for (const c of cats) {
      const hit = CATEGORY_SUBCATEGORIES[c].find(x => foldKey(x) === foldKey(subRaw));
      if (hit && (!cat || cat === c)) { sub = hit; cat = c; break; }
    }
    if (!sub && cat) sub = subRaw;
  }
  return { category: cat, subcategory: sub };
}

function categoryFromPsa(psaCategory) {
  const hit = PSA_CATEGORY_HINTS.find(([re]) => re.test(psaCategory || ''));
  return hit ? { category: hit[1], subcategory: hit[2] } : null;
}

// Same shape as buildCardTitle() in app.html: "{year} {set} {player} {parallel}"
// for sports and non-sport, with "#{number}" for TCG.
function buildCardTitle({ year, card_set, player, parallel, card_number, category }) {
  const num = category === 'TCG' && card_number ? `#${String(card_number).replace(/^#/, '')}` : null;
  return [year, card_set, player, num, parallel].map(v => norm(v)).filter(Boolean).join(' ') || null;
}

// Admin gate for the review UI and manual intake: a valid Supabase session
// whose uid is in the admins table.
async function requireAdmin(db, event) {
  const auth  = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!db || !token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: row } = await db.from('admins').select('id').eq('id', data.user.id).maybeSingle();
  return row ? data.user : null;
}

function isPipelineCall(event) {
  const secret = process.env.SOCIAL_PIPELINE_SECRET;
  const got = event.headers[PIPELINE_SECRET_HEADER] || event.headers[PIPELINE_SECRET_HEADER.toLowerCase()];
  return !!secret && got === secret;
}

function siteBase(event) {
  const host = event?.headers?.host;
  if (host && !/^localhost|^127\./.test(host)) return `https://${host}`;
  if (host) return `http://${host}`;
  return process.env.DEPLOY_PRIME_URL || process.env.URL || '';
}

// Fire the next stage. Background functions answer 202 right away, so this
// returns quickly. Failure is logged; the hourly sweep re-kicks stuck rows.
async function kickStage(base, fnName, body = {}) {
  const secret = process.env.SOCIAL_PIPELINE_SECRET;
  if (!secret || !base) {
    console.warn(`[social] cannot kick ${fnName}: ${!secret ? 'SOCIAL_PIPELINE_SECRET not set' : 'no site URL'}`);
    return false;
  }
  try {
    const res = await fetch(`${base}/.netlify/functions/${fnName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [PIPELINE_SECRET_HEADER]: secret },
      body: JSON.stringify({ ...body, base }),
    });
    if (!res.ok && res.status !== 202) console.warn(`[social] kick ${fnName} → HTTP ${res.status}`);
    return res.ok || res.status === 202;
  } catch (err) {
    console.warn(`[social] kick ${fnName} failed:`, err.message);
    return false;
  }
}

// ── Intake helpers ───────────────────────────────────────────────────────────
// Parse a post URL into { platform, platformPostId }. Returns null if it isn't
// a recognizable Instagram or X post link.
function parsePostUrl(url) {
  const u = norm(url);
  if (!u) return null;
  let m = u.match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (m) return { platform: 'instagram', platformPostId: m[1] };
  m = u.match(/(?:twitter|x)\.com\/[^/?#]+\/status(?:es)?\/(\d+)/i);
  if (m) return { platform: 'x', platformPostId: m[1] };
  m = u.match(/^https?:\/\/[^\s]+$/i);
  if (m) return { platform: 'other', platformPostId: u.replace(/[?#].*$/, '').toLowerCase() };
  return null;
}

function postKeyFor(platform, platformPostId) {
  return sha256(`${platform}:${platformPostId}`);
}

// D3: drop @handles and URLs from anything we store.
function cleanCaption(caption) {
  return norm(caption)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(^|[^\w])@[A-Za-z0-9_.]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Caption parsing ──────────────────────────────────────────────────────────
// Every dollar amount in the caption, in order. Handles "$1,450", "$1450.00",
// "$1.2k", "1450$", "1.5k".
function captionAmounts(caption) {
  const text = norm(caption);
  const out = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\b|\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s?\$|\b(\d+(?:\.\d+)?)k\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1] || m[3] || m[5];
    const k   = !!(m[2] || m[4] || m[5]);
    let n = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (k) n *= 1000;
    out.push({ amount: Math.round(n * 100) / 100, index: m.index, text: m[0] });
  }
  return out;
}

// "asking 1600, sold 1450" / "was $1,600, let it go for $1,450" / "listed at X got Y".
function captionAskSoldPattern(caption) {
  const text = norm(caption);
  const amounts = captionAmounts(text);
  if (amounts.length !== 2) return null;
  const [a, b] = amounts;
  const before = text.slice(0, a.index).toLowerCase().slice(-30);
  const between = text.slice(a.index + a.text.length, b.index).toLowerCase();
  const askWord  = /(ask(ing|ed)?|list(ed)?|sticker|tagged|was|price[d]?)\W*(at|for)?\W*$/;
  const soldWord = /(sold|let (it )?go|got|took|paid|settled|went for|for)\b/;
  if (askWord.test(before) && soldWord.test(between)) return { asking: a.amount, sold: b.amount };
  return null;
}

const KILL_RE  = /\b(for sale|available|dm (me )?to buy|dm for price|taking offers|best offer|obo|auction|bid|break|giveaway|raffle|trade only|lot of|bundle)\b/i;
const SALE_RE  = /\b(sold|pick ?up|picked up|pulled the trigger|paid|got it for|bought|cash|at the show)\b|\$\s?\d/i;
const GRADE_RE = /\b(psa|bgs|beckett|sgc|cgc|tag ?grad\w*|slab(bed)?|graded|gem mint|black label)\b/i;
const TRADE_RE = /\b(trade[ds]?|traded|trading|t\/c|swap(ped)?|offers?|obo)\b/i;
const BUNDLE_RE = /\b(lot|bundle|for both|for all|both for|all for|x2|pair|the pair|2 for|3 for)\b/i;
// Caption says a sale happened (amount or not). Used to keep a price-unknown sale for review.
const SOLD_WORD_RE = /\b(sold|closed (out )?(the|a|this) deal|closing out|let (it|this|her|him) go|cashed out|in\s*\/\s*out)\b/i;

// Funnel stage 2 (§2A): free caption text filter. Advisory for manual intake
// (a human already chose the post); enforced for discovery channels.
function captionFilter(caption, { fromShowTag = false, hashtags = [] } = {}) {
  const text = `${norm(caption)} ${hashtags.map(t => '#' + t).join(' ')}`;
  if (!norm(caption)) {
    return fromShowTag ? { pass: true, reason: 'empty_caption_show_tag' } : { pass: false, reason: 'empty_caption' };
  }
  if (KILL_RE.test(text)) return { pass: false, reason: 'kill_signal' };
  const sale = SALE_RE.test(text), grade = GRADE_RE.test(text);
  if ((sale && grade) || (fromShowTag && (sale || grade))) return { pass: true, reason: sale && grade ? 'sale_and_grader' : 'show_tag' };
  return { pass: false, reason: !sale ? 'no_sale_signal' : 'no_grader_signal' };
}

// ── Claude ───────────────────────────────────────────────────────────────────
let _anthropic = null;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
  return _anthropic;
}

function parseJsonFromText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(s.slice(start, end + 1));
}

function responseText(response) {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

const EXTRACT_SYSTEM_PROMPT = `You extract graded trading card SALES from social media posts taken at card shows.
Return ONLY a JSON object (no markdown fences, no preamble). Never guess: use null when a value
is not clearly visible.

First decide which graded slabs the post is ABOUT. A subject slab is the one being shown off as
sold or bought: it is the focus of the photo (centered, held up, singled out, labeled with text
like "Out" or "Sold", or set apart next to cash or a price). Slabs that are only in the background
(other inventory in a display case, binder, table or stack, partly cut off or out of focus) are
NOT subject slabs. Ignore them completely: do not list them and do not count them.
Count DISTINCT subject slabs across all images. The same slab shown in several images counts once
(match by cert number or identical label). Report that number as distinct_slab_count, and the
number of background slabs you ignored as background_slab_count. If distinct_slab_count is not 1,
still list the subject slabs but set sold_price and sticker_price to null on all of them.

SALE SIGNALS. A common show-floor format overlays the word "Out" on the card and "In" on cash: the
card went out and the cash came in, which means the card was SOLD for that cash. Report at the top
level:
- sale_signal: true if the post clearly shows the subject slab was sold (an "In/Out" overlay with
  cash, the slab posed with cash as payment, or caption words like "sold", "closed the deal",
  "let it go"), even when the amount cannot be determined. false otherwise.
- cash_visible: true if cash is shown with the subject slab.

For EVERY subject slab, report:
- grader: "PSA" | "BGS" | "SGC" | "CGC" | "TAG" | "OTHER"
- cert_number: the digits exactly as printed on the slab label, keeping leading zeros. If any digit
  is unreadable, set cert_number to null and put your best partial read in cert_partial with "?"
  for each unknown digit.
- grade (number, e.g. 10 or 9.5) and grade_label (e.g. "GEM MT", "PRISTINE", "BLACK LABEL")
- card: year, card_set (brand and set), card_number, player (player or character), parallel,
  all as printed
- category: "Sports" | "TCG" | "Non-Sport", and subcategory: the sport, game or franchise, using one
  of these names when it fits: Baseball, Basketball, Football, Hockey, Soccer, Golf, Boxing, MMA/UFC,
  Wrestling, Racing/Motorsports, Tennis, Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece Card Game,
  Disney Lorcana, Digimon Card Game, Marvel, Star Wars, Disney, DC, Star Trek. null if unsure.
- image_index (0-based) and bbox [x, y, w, h] normalized 0-1 for the image where it is clearest

PRICES. Report two separate things per slab:
1. sticker_price: the amount on a price sticker attached to the slab, if any. A sticker is ALWAYS an
   asking price, never a sale price. null if there is no sticker.
2. sold_price: the amount actually paid, ONLY from one of these, in this priority order:
   "caption_explicit" (the caption states the sold or paid amount)
   "image_text" (a handwritten or printed sale amount in the image that is not the slab sticker)
   "cash_shown" (cash physically beside or on the slab: count the visible bills and report what you
   saw in cash_bills_seen, e.g. "3x$100, 1x$50"). Only when every bill can be counted; fanned or
   stacked bills that overlap so that some are hidden can't be counted, so leave sold_price null.
   Never use the sticker as sold_price. null if none of these exist. A missing amount is fine:
   report null and set sale_signal instead.
   Report sold_price_source as one of those three strings, or null.
- price_currency: "USD" unless the post clearly uses another currency, then its ISO code.
- is_trade: true if the post describes a trade or trade plus cash.
- conf: {"cert": 0-1, "card": 0-1, "price_link": 0-1} — how sure you are of the cert read, the card
  identity, and that the price belongs to this slab.

Also report at the top level:
- post_role: "seller_sold" | "buyer_pickup" | "unclear"
- show_hints: show names, hashtags, venue or city text, and dates found in the caption or images
- sale_date_hints: words like "today", "yesterday", "saturday", or dates
- notes: anything ambiguous, in one short string

JSON shape:
{"post_role": "...", "show_hints": [], "sale_date_hints": [], "distinct_slab_count": 1,
 "background_slab_count": 0, "sale_signal": false, "cash_visible": false,
 "slabs": [{"image_index": 0, "bbox": [0,0,0,0], "grader": "PSA", "cert_number": "...",
   "cert_partial": null, "grade": 10, "grade_label": "GEM MT",
   "card": {"year": "", "card_set": "", "card_number": "", "player": "", "parallel": ""},
   "category": null, "subcategory": null,
   "sticker_price": null, "sold_price": null, "price_currency": "USD", "sold_price_source": null,
   "cash_bills_seen": null, "is_trade": false, "conf": {"cert": 0, "card": 0, "price_link": 0}}],
 "notes": ""}`;

// One call per post: every image plus the caption, so a price in one image can
// be tied to a slab in another.
async function extractPost({ images, caption }) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Image ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: 'text', text: `Caption (handles removed):\n${caption || '(no caption)'}` });

  const response = await anthropic().beta.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('model refused the extraction'), { reason: 'refusal' });
  }
  if (response.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('extraction hit max_tokens'), { reason: 'max_tokens' });
  }
  return {
    result: parseJsonFromText(responseText(response)),
    model: response.model,
    tokensIn: response.usage?.input_tokens ?? null,
    tokensOut: response.usage?.output_tokens ?? null,
  };
}

// Funnel stage 3 (§2A): cheap low-res yes/no triage. Returns
// { oneSlab, priceVisible } or null on any failure (caller decides).
async function triageImage({ base64, mediaType }) {
  try {
    const response = await anthropic().messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 200,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Answer with JSON only: {"one_slab": true|false, "price_visible": true|false}. one_slab: the photo is about exactly one graded card slab (other slabs in the background, e.g. in a display case or binder, do not count). price_visible: cash or a written price is visible next to it.' },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return null;
    const r = parseJsonFromText(responseText(response));
    return { oneSlab: r.one_slab === true, priceVisible: r.price_visible === true };
  } catch (err) {
    console.warn('[social] triage failed:', err.message);
    return null;
  }
}

// ── Deterministic post-processing (§3) ───────────────────────────────────────
function normalizeGrader(g) {
  const up = norm(g).toUpperCase();
  if (up === 'BECKETT') return 'BGS';
  return GRADERS.includes(up) ? up : (up ? 'OTHER' : null);
}

function normalizeCert(grader, cert) {
  const c = norm(cert).replace(/\s+/g, '').toUpperCase();
  if (!c) return null;
  const re = CERT_FORMATS[grader];
  return re && re.test(c) ? c : null;
}

// Turn the model's output for one post into extraction rows plus a post-level
// verdict. Pure function: no I/O, so it is easy to test.
function processExtraction(result, caption) {
  const slabs = Array.isArray(result?.slabs) ? result.slabs : [];
  const distinct = Number.isFinite(Number(result?.distinct_slab_count))
    ? Number(result.distinct_slab_count) : slabs.length;

  if (distinct === 0 || slabs.length === 0) return { postStatus: 'no_slab', rows: [] };
  if (distinct !== 1) return { postStatus: 'multi_card', rejectReason: 'multi_card', rows: [] };
  if (BUNDLE_RE.test(norm(caption))) return { postStatus: 'multi_card', rejectReason: 'bundle_language', rows: [] };

  // distinct === 1: the model may still list the same slab twice; keep the one
  // with the best cert read.
  const slab = slabs.slice().sort((a, b) => (b?.conf?.cert ?? 0) - (a?.conf?.cert ?? 0))[0];
  const reasons = [];
  const grader = normalizeGrader(slab.grader);
  const rawCert = norm(slab.cert_number);
  const cert = grader ? normalizeCert(grader, rawCert) : null;
  let certPartial = norm(slab.cert_partial) || null;
  if (rawCert && !cert) {
    certPartial = certPartial || rawCert;
    reasons.push('cert_format_invalid');
  }

  const captionAmts = captionAmounts(caption);
  const distinctCaptionAmts = [...new Set(captionAmts.map(a => a.amount))];
  const askSold = captionAskSoldPattern(caption);

  let soldPrice  = numOrNull(slab.sold_price);
  let soldSource = ['caption_explicit', 'image_text', 'cash_shown'].includes(slab.sold_price_source)
    ? slab.sold_price_source : (soldPrice != null ? 'image_text' : null);
  const sticker  = numOrNull(slab.sticker_price);

  if (askSold) {
    // The explicit "asking X, sold Y" caption wins over the model's read.
    soldPrice = askSold.sold;
    soldSource = 'caption_explicit';
  } else if (soldSource === 'caption_explicit') {
    if (!distinctCaptionAmts.length) {
      soldSource = 'image_text';
      reasons.push('caption_price_not_found');
    } else if (!distinctCaptionAmts.some(a => Math.abs(a - soldPrice) < 0.01)) {
      reasons.push('caption_price_mismatch');
    }
  }
  if (distinctCaptionAmts.length > 1 && !askSold) reasons.push('multiple_caption_amounts');

  // Never let the sticker stand in for a sold price.
  if (sticker != null && soldPrice != null && Math.abs(sticker - soldPrice) < 0.01 && soldSource !== 'caption_explicit') {
    reasons.push('sold_equals_sticker');
  }

  let askingPrice = null, askingBasis = null;
  if (sticker != null) { askingPrice = sticker; askingBasis = 'sticker'; }
  else if (askSold)    { askingPrice = askSold.asking; askingBasis = 'caption_ask'; }
  else if (soldPrice != null) { askingPrice = soldPrice; askingBasis = 'assumed_equal_sold'; }

  if (soldPrice != null && askingBasis === 'sticker' && soldPrice > sticker) reasons.push('sold_above_sticker');
  if (soldSource === 'cash_shown') reasons.push('cash_count');

  const currency = norm(slab.price_currency || 'USD').toUpperCase() || 'USD';
  if (currency !== 'USD') reasons.push('non_usd');

  const isTrade = slab.is_trade === true || TRADE_RE.test(norm(caption));

  // A clear sale with no readable amount (e.g. an "In/Out" post with fanned
  // cash) goes to review so a person can enter the price; a sticker or a bare
  // photo with no sign of a sale is still rejected.
  if (soldPrice != null && soldPrice <= 0) soldPrice = null;
  const saleSignal = result?.sale_signal === true || result?.cash_visible === true
    || norm(slab.cash_bills_seen) !== '' || SOLD_WORD_RE.test(norm(caption));
  const priceUnknown = soldPrice == null && saleSignal;
  if (soldPrice == null) soldSource = null;
  if (priceUnknown) reasons.push('price_unknown');

  let status = 'pending_verify', rejectReason = null;
  if (isTrade)                        { status = 'rejected'; rejectReason = 'trade'; }
  else if (soldPrice == null && !priceUnknown) { status = 'rejected'; rejectReason = 'no_sold_price'; }
  else if (!grader || grader === 'OTHER') { status = 'rejected'; rejectReason = 'unsupported_grader'; }
  else if (!cert && !certPartial)      { status = 'rejected'; rejectReason = 'no_cert'; }

  // Accept the v1 prompt's key names too (subject / set / variant).
  const card = slab.card || {};
  const player   = norm(card.player ?? card.subject) || null;
  const cardSet  = norm(card.card_set ?? card.set) || null;
  const parallel = norm(card.parallel ?? card.variant) || null;
  const cardNumber = norm(card.card_number).replace(/^#/, '') || null;
  const { category, subcategory } = resolveCategory(slab.category, slab.subcategory);
  return {
    postStatus: 'extracted',
    rows: [{
      slab_index:  0,
      image_index: Number.isInteger(slab.image_index) ? slab.image_index : null,
      bbox:        Array.isArray(slab.bbox) ? slab.bbox.slice(0, 4) : null,
      grader,
      cert_number: cert,
      cert_partial: cert ? null : certPartial,
      grade:       normalizeGrade(slab.grade),
      grade_label: norm(slab.grade_label) || null,
      year:        normalizeYear(card.year),
      card_set:    cardSet,
      card_number: cardNumber,
      player,
      parallel,
      card_title:  buildCardTitle({ year: norm(card.year), card_set: cardSet, player, parallel, card_number: cardNumber, category }),
      category,
      subcategory,
      sticker_price: sticker,
      sold_price:  soldPrice,
      sold_price_source: soldSource,
      cash_bills_seen: norm(slab.cash_bills_seen) || null,
      asking_price: askingPrice,
      asking_price_basis: askingBasis,
      currency,
      is_trade:    isTrade,
      post_role:   ['seller_sold', 'buyer_pickup', 'unclear'].includes(result.post_role) ? result.post_role : 'unclear',
      conf:        slab.conf || null,
      verify_status: cert ? 'pending' : 'no_cert',
      route_reasons: reasons,
      status,
      reject_reason: rejectReason,
    }],
  };
}

// ── Verification (§4) ────────────────────────────────────────────────────────
function gradeFromLabel(label) {
  const m = norm(label).match(/(\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
}

function normalizePsaCert(certNumber, data) {
  const c = data?.PSACert || {};
  const label = c.CardGrade || c.GradeDescription || '';
  return {
    grader: 'PSA',
    cert_number: certNumber,
    valid: true,
    year: norm(c.Year) || null,
    card_set: norm(c.Brand) || null,
    card_number: norm(c.CardNumber) || null,
    player: norm(c.Subject) || null,
    parallel: norm(c.Variety) || null,
    grade: normalizeGrade(gradeFromLabel(label)),
    grade_label: norm(label) || null,
    category: norm(c.Category) || null,
    raw: data,
    source: 'psa_api',
  };
}

// Returns { status: 'verified'|'not_found'|'budget'|'error'|'unsupported', cert }
async function lookupCert(db, grader, certNumber) {
  const { data: cached } = await db.from('graded_certs')
    .select('*').eq('grader', grader).eq('cert_number', certNumber).maybeSingle();
  if (cached) return { status: cached.valid ? 'verified' : 'not_found', cert: cached, cached: true };

  if (grader !== 'PSA') return { status: 'unsupported' };
  const token = process.env.PSA_API_TOKEN;
  // No token, or PSA refusing our account (access is still pending approval):
  // retrying won't help, so the slab goes to review unchecked instead of waiting.
  if (!token) return { status: 'unavailable', error: 'PSA_API_TOKEN not set' };

  const { data: allowed, error: budgetErr } = await db.rpc('claim_api_call', { p_key: 'psa', p_limit: PSA_DAILY_LIMIT });
  if (budgetErr) return { status: 'error', error: budgetErr.message };
  if (!allowed) return { status: 'budget' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(certNumber)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 429) return { status: 'budget' };
    if (res.status === 401 || res.status === 403) return { status: 'unavailable', error: `PSA HTTP ${res.status}` };
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* non-JSON */ }
    if (res.status === 404) data = data || { IsValidRequest: true, ServerMessage: 'No data found' };
    if (!res.ok && res.status !== 404) return { status: 'error', error: `PSA HTTP ${res.status}` };

    // A 200 doesn't guarantee data: check IsValidRequest / PSACert.
    const noData = !data?.PSACert || data?.IsValidRequest === false || /no data/i.test(data?.ServerMessage || '');
    if (noData) {
      const definitive = /no data/i.test(data?.ServerMessage || '') || res.status === 404;
      if (!definitive) return { status: 'error', error: data?.ServerMessage || 'invalid request' };
      const row = { grader: 'PSA', cert_number: certNumber, valid: false, raw: data, source: 'psa_api' };
      await db.from('graded_certs').upsert(row, { onConflict: 'grader,cert_number' });
      return { status: 'not_found', cert: row };
    }
    const row = normalizePsaCert(certNumber, data);
    await db.from('graded_certs').upsert(row, { onConflict: 'grader,cert_number' });
    return { status: 'verified', cert: row };
  } catch (err) {
    return { status: 'error', error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const tokens = (s) => lc(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length > 1);
function tokenOverlap(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return null;
  let hit = 0;
  ta.forEach(t => { if (tb.has(t)) hit++; });
  return hit / Math.min(ta.size, tb.size);
}
const cardNum = (s) => lc(s).replace(/^#/, '').replace(/^0+(?=\d)/, '');

// Field-level comparison of the vision read against the grader's record.
// Fields missing on either side are left out and the weights renormalized.
// Returns { score, mismatched: [field] } or { score: null } if nothing to compare.
function cardMatch(ext, cert) {
  const parts = [];
  const mismatched = [];
  const add = (field, weight, value) => {
    if (value === null || value === undefined) return;
    parts.push({ weight, value });
    if (value < 0.5) mismatched.push(field);
  };
  if (ext.grade != null && cert.grade != null) add('grade', 0.25, Number(ext.grade) === Number(cert.grade) ? 1 : 0);
  add('player', 0.3, ext.player && cert.player ? tokenOverlap(ext.player, cert.player) : null);
  if (ext.year && cert.year) {
    const ey = (norm(ext.year).match(/\d{4}/) || [])[0];
    const cy = (norm(cert.year).match(/\d{4}/) || [])[0];
    add('year', 0.15, ey && cy ? (ey === cy ? 1 : 0) : null);
  }
  if (ext.card_number && cert.card_number) add('card_number', 0.15, cardNum(ext.card_number) === cardNum(cert.card_number) ? 1 : 0);
  add('card_set', 0.15, ext.card_set && cert.card_set ? tokenOverlap(ext.card_set, cert.card_set) : null);
  if (!parts.length) return { score: null, mismatched };
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const score = parts.reduce((s, p) => s + p.weight * Math.min(1, p.value), 0) / total;
  return { score: Math.round(score * 1000) / 1000, mismatched };
}

// One unknown digit: try the ≤10 candidates against the cache only (never the
// API). Accept only if exactly one candidate matches the vision-read card.
async function recoverPartialCert(db, ext) {
  const partial = norm(ext.cert_partial).toUpperCase();
  if (!ext.grader || (partial.match(/\?/g) || []).length !== 1) return null;
  const candidates = [];
  for (let d = 0; d <= 9; d++) candidates.push(partial.replace('?', String(d)));
  const { data } = await db.from('graded_certs')
    .select('*').eq('grader', ext.grader).eq('valid', true).in('cert_number', candidates);
  const matches = (data || []).filter(c => (cardMatch(ext, c).score ?? 0) >= 0.9);
  return matches.length === 1 ? matches[0] : null;
}

// GTCR stolen/lost lookup (read key). Never blocks a sale record; only flags.
async function stolenCheck(grader, certNumber) {
  const key = process.env.GTCR_READ_API_KEY;
  if (!key || !certNumber) return null;
  const base = (process.env.GTCR_API_BASE || 'https://thegtcr.com/functions').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${base}/trustCheckApi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gtcr-api-key': key },
      body: JSON.stringify({ cert_number: certNumber, grading_company: grader, partner_id: process.env.GTCR_PARTNER_ID || 'cardshow' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const status = String(body?.card_status ?? body?.data?.card_status ?? '').toUpperCase();
    const reports = body?.reports || {};
    const stolen = /STOLEN/.test(status) || !!(reports.has_stolen_report ?? body?.has_stolen_report);
    const lost   = /LOST|MISSING/.test(status) || !!(reports.has_lost_report ?? body?.has_lost_report);
    return { source: 'gtcr', card_status: status || null, stolen, lost, flagged: stolen || lost };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Comps (§5 sanity band) ───────────────────────────────────────────────────
// Asks the existing comp-lookup function (Card Hedge → CardSight →
// PriceCharting, high-confidence only). Returns the comp price or null.
async function compMedian(base, ext) {
  if (!base) return null;
  try {
    const res = await fetch(`${base}/.netlify/functions/comp-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: [{
        id: ext.id,
        player: ext.player || '',
        year: ext.year || null,
        cardSet: ext.card_set || '',
        cardNumber: ext.card_number || '',
        grade: ext.grade,
        grader: ext.grader,
        parallel: ext.parallel || '',
        sport: '',
        cardTitle: ext.card_title || [ext.year, ext.card_set, ext.player, ext.parallel].filter(Boolean).join(' '),
      }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results?.[0];
    return r && !r.stub && Number(r.compPrice) > 0 ? Number(r.compPrice) : null;
  } catch (_) {
    return null;
  }
}

function sanityFlag(sold, median) {
  if (!median) return 'no_comp';
  if (sold == null) return null; // price unknown: nothing to compare yet
  const ratio = sold / median;
  if (ratio < SANITY_LOW) return 'low';
  if (ratio > SANITY_HIGH) return 'high';
  return null;
}

// ── Show attribution & sale date (§6) ────────────────────────────────────────
function parseShowDateText(dateStr) {
  if (!dateStr) return null;
  const cleaned = String(dateStr).replace(/(\d{1,2})\s*-\s*\d{1,2}(\s*,)/, '$1$2');
  const d = new Date(cleaned);
  return isNaN(d) ? null : d;
}

// [start, end] as UTC-midnight Dates, from start_date/end_date or the display text.
function showRange(show) {
  const toDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00Z`) : null);
  let start = toDate(show.start_date), end = toDate(show.end_date);
  if (!start) {
    const parsed = parseShowDateText(show.date);
    if (parsed) {
      start = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
      const m = String(show.date || '').match(/(\d{1,2})\s*-\s*(\d{1,2})\s*,/);
      end = m ? addDays(start, Number(m[2]) - Number(m[1])) : start;
    }
  }
  if (start && !end) end = start;
  return start ? { start, end } : null;
}

const STOP = new Set(['the', 'card', 'cards', 'show', 'expo', 'and', 'of', 'collectibles', 'collectors', 'sports', 'trading', 'fair']);

// Score each candidate show; return the best one if it clears the bar.
// Date alone never attributes a post (a weekend can have several shows).
function attributeShow({ shows, hashtags, caption, showHints, postedAt, sourceHashtag }) {
  if (!postedAt) return { showId: null, method: 'unattributed', score: 0 };
  const text = lc([caption, ...(showHints || [])].join(' '));
  const winStart = addDays(postedAt, -3), winEnd = addDays(postedAt, 1);
  const scored = [];
  for (const show of shows) {
    const range = showRange(show);
    if (!range) continue;
    if (range.end < addDays(winStart, -1) || range.start > winEnd) continue;
    let score = 0, method = null;
    const tags = hashtags.filter(h => h.show_id === show.id).map(h => lc(h.tag));
    if (tags.some(t => (sourceHashtag && lc(sourceHashtag) === t) || new RegExp(`#${t}\\b`).test(text))) {
      score += 0.6; method = 'hashtag';
    }
    const nameTokens = tokens(show.name).filter(t => !STOP.has(t) && t.length > 2);
    const nameHits = nameTokens.filter(t => text.includes(t)).length;
    if (lc(show.name) && text.includes(lc(show.name))) { score += 0.5; method = method || 'name'; }
    else if (nameTokens.length && nameHits >= Math.min(2, nameTokens.length)) { score += 0.4; method = method || 'name'; }
    const places = [show.city, show.venue].map(lc).filter(p => p && p.length > 2);
    if (places.some(p => text.includes(p))) { score += 0.25; method = method || 'venue_city'; }
    // State is weak (a 2-letter code): it can support a match but never
    // reaches the threshold alone, even with the date.
    const st = norm(show.state);
    if (st.length >= 2 && new RegExp(`\\b${st.replace(/[^A-Za-z ]/g, '')}\\b`, 'i').test(text)) {
      score += 0.15; method = method || 'state';
    }
    const inside = postedAt >= range.start && postedAt <= addDays(range.end, 1);
    score += inside ? 0.15 : 0.05;
    if (method) scored.push({ showId: show.id, method, score: Math.min(1, score) });
  }
  scored.sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (!top || top.score < 0.4) return { showId: null, method: 'unattributed', score: top?.score || 0 };
  if (second && second.score > top.score - 0.1) return { showId: null, method: 'ambiguous', score: top.score };
  return top;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function resolveSoldDate({ dateHints, caption, postedAt, show }) {
  const posted = postedAt ? new Date(Date.UTC(postedAt.getUTCFullYear(), postedAt.getUTCMonth(), postedAt.getUTCDate())) : null;
  const text = lc([caption, ...(dateHints || [])].join(' '));
  if (posted) {
    if (/\byesterday\b/.test(text)) return { date: isoDate(addDays(posted, -1)), basis: 'caption' };
    if (/\b(today|tonight|this morning)\b/.test(text)) return { date: isoDate(posted), basis: 'caption' };
    const wd = text.match(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|rsday|urday|sday)?\b/);
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1].slice(0, 3));
      const back = (posted.getUTCDay() - target + 7) % 7;
      return { date: isoDate(addDays(posted, -back)), basis: 'caption' };
    }
  }
  const range = show ? showRange(show) : null;
  if (range && posted) {
    const clamped = posted < range.start ? range.start : posted > range.end ? range.end : posted;
    return { date: isoDate(clamped), basis: 'show_day' };
  }
  return { date: posted ? isoDate(posted) : null, basis: 'posted_at' };
}

// ── Scoring & routing (§8) ───────────────────────────────────────────────────
const PRICE_SCORE = { caption_explicit: 1.0, image_text: 0.8, cash_shown: 0.5, reviewer: 1.0 };
function certScore(verifyStatus) {
  return { verified: 1.0, partner_verified: 0.7, format_only: 0.4, unsupported_grader: 0.4 }[verifyStatus] ?? 0;
}
function overallScore({ certScore: c, cardMatch: m, priceScore: p, showScore: s, corroborated }) {
  const base = 0.35 * c + 0.25 * (m ?? 0) + 0.30 * p + 0.10 * (s ?? 0);
  return Math.round(Math.min(1, base + (corroborated ? 0.1 : 0)) * 1000) / 1000;
}

// Only the highest-confidence pattern; measured on every row via auto_eligible.
function isAutoEligible(ext) {
  return ext.grader === 'PSA'
    && ext.verify_status === 'verified'
    && (ext.card_match_score ?? 0) >= 0.9
    && ext.sold_price_source === 'caption_explicit'
    && (ext.asking_price_basis !== 'sticker' || ext.sold_price <= ext.sticker_price)
    && ext.sanity_flag == null
    && !!ext.show_id
    && !ext.stolen_flag
    && (ext.currency || 'USD') === 'USD'
    && !(ext.route_reasons || []).length;
}

const CRITICAL_FIELDS = ['grader', 'cert_number', 'grade', 'sold_price', 'player', 'year', 'card_number', 'card_set'];

// D5: auto-approve only once ≥200 reviewed auto-eligible rows were approved
// without a correction to a critical field at ≥98%.
async function autoApproveGate(db) {
  if (process.env.SOCIAL_AUTO_APPROVE !== 'true') return { open: false, reason: 'SOCIAL_AUTO_APPROVE not true' };
  const { data, error } = await db.from('social_extractions')
    .select('status, edited_fields').eq('auto_eligible', true).not('reviewed_at', 'is', null)
    .in('status', ['approved', 'approved_offfloor', 'rejected', 'duplicate']).limit(5000);
  if (error) return { open: false, reason: error.message };
  const reviewed = data.length;
  const clean = data.filter(r => r.status !== 'rejected'
    && !(r.edited_fields || []).some(f => CRITICAL_FIELDS.includes(f))).length;
  const precision = reviewed ? clean / reviewed : 0;
  const open = reviewed >= AUTO_APPROVE_MIN_REVIEWED && precision >= AUTO_APPROVE_MIN_PRECISION;
  return { open, reviewed, precision, reason: open ? null : 'precision gate not met' };
}

// ── Dedup + publish (§7) ─────────────────────────────────────────────────────
const SOURCE_RANK = { reviewer: 4, caption_explicit: 3, image_text: 2, cash_shown: 1 };

async function findSameSale(db, grader, certNumber, soldDate) {
  if (!grader || !certNumber || !soldDate) return null;
  const d = new Date(`${soldDate}T00:00:00Z`);
  const { data } = await db.from('social_sales').select('*')
    .eq('grader', grader).eq('cert_number', certNumber)
    .gte('sold_date', isoDate(addDays(d, -DEDUP_DAYS)))
    .lte('sold_date', isoDate(addDays(d, DEDUP_DAYS)))
    .order('sold_date').limit(1);
  return data?.[0] || null;
}

const samePrice = (a, b) => Math.abs(Number(a) - Number(b)) <= Math.max(1, 0.01 * Number(b));

// Write an extraction into social_sales, merging into an existing sale for the
// same cert within ±3 days. Returns { saleId, merged } or { conflict, existing }.
async function publishExtraction(db, ext, { method, onFloor, force = false }) {
  const existing = await findSameSale(db, ext.grader, ext.cert_number, ext.sold_date);
  if (existing) {
    if (!samePrice(ext.sold_price, existing.sold_price) && !force) return { conflict: true, existing };
    const patch = { corroboration_count: existing.corroboration_count + 1, updated_at: new Date().toISOString() };
    const better = (SOURCE_RANK[ext.sold_price_source] || 0) > (SOURCE_RANK[existing.sold_price_source] || 0);
    if (force || better) {
      patch.sold_price = ext.sold_price;
      patch.sold_price_source = ext.sold_price_source;
    }
    if (ext.asking_price_basis === 'sticker' && existing.asking_price_basis !== 'sticker') {
      patch.asking_price = ext.asking_price;
      patch.asking_price_basis = 'sticker';
    }
    if (!existing.show_id && ext.show_id && onFloor) { patch.show_id = ext.show_id; patch.on_floor = true; patch.show_match_method = ext.show_match_method; }
    if (ext.stolen_flag) patch.stolen_flag = true;
    const { error } = await db.from('social_sales').update(patch).eq('id', existing.id);
    if (error) throw new Error(`merge failed: ${error.message}`);
    return { saleId: existing.id, merged: true };
  }

  const row = {
    grader: ext.grader,
    cert_number: ext.cert_number,
    grade: ext.grade,
    grade_label: ext.grade_label,
    year: ext.year,
    card_set: ext.card_set,
    card_number: ext.card_number,
    player: ext.player,
    parallel: ext.parallel,
    card_title: ext.card_title || buildCardTitle(ext),
    category: ext.category || null,
    subcategory: ext.subcategory || null,
    sold_price: ext.sold_price,
    sold_price_source: ext.sold_price_source,
    asking_price: ext.asking_price,
    asking_price_basis: ext.asking_price_basis,
    currency: ext.currency || 'USD',
    sold_date: ext.sold_date,
    sold_date_basis: ext.sold_date_basis,
    show_id: onFloor ? ext.show_id : null,
    show_match_method: onFloor ? ext.show_match_method : (ext.show_match_method || 'unattributed'),
    on_floor: !!(onFloor && ext.show_id),
    cert_verified: ext.verify_status === 'verified',
    stolen_flag: !!ext.stolen_flag,
    approval_method: method,
  };
  const { data, error } = await db.from('social_sales').insert(row).select('id').single();
  if (error) throw new Error(`insert failed: ${error.message}`);
  return { saleId: data.id, merged: false };
}

// When every extraction of a post is final, start the evidence clock (D4).
const FINAL = ['approved', 'approved_offfloor', 'auto_approved', 'rejected', 'duplicate'];
async function maybeSchedulePurge(db, postId) {
  const { data } = await db.from('social_extractions').select('status').eq('post_id', postId);
  if ((data || []).every(r => FINAL.includes(r.status))) {
    await db.from('social_posts').update({
      purge_after: addDays(new Date(), RETENTION_DAYS).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', postId).is('purge_after', null);
  }
}

// ── Discovery funnel (§2A) ──────────────────────────────────────────────────
// Stages 1-3 for one post. Survivors go to 'queued'; the rest to
// 'filtered_out' with filter_stage / filter_reason. Counts per stage go to
// hashtag_yield under the post's source_hashtag. Returns the new status.
const DISCOVERY_METHODS = ['ig_mention', 'ig_tag', 'ig_hashtag', 'ig_watchlist', 'x_search'];

async function isActiveShowTag(db, tag) {
  if (!tag) return false;
  const today = isoDate(new Date());
  const { data } = await db.from('show_hashtags').select('id, active_from, active_until')
    .eq('tag', lc(tag).replace(/^#/, '')).eq('tier', 'show').eq('active', true);
  return (data || []).some(h => (!h.active_from || h.active_from <= today) && (!h.active_until || h.active_until >= today));
}

async function prefilterPost(db, post) {
  const counts = { seen: 1 };
  const now = new Date().toISOString();
  const finish = async (status, stage, reason, extra = {}) => {
    await db.from('social_posts').update({
      status, filter_stage: stage, filter_reason: reason, claimed_at: null, updated_at: now,
      purge_after: status === 'filtered_out' ? addDays(new Date(), RETENTION_DAYS).toISOString() : null,
      ...extra,
    }).eq('id', post.id);
    await bumpYield(db, post.source_hashtag, counts);
    return status;
  };

  // Stage 1 — metadata: at least one stored image. (Duplicates never get this
  // far: post_key and media sha256 are unique.)
  const { data: media } = await db.from('social_post_media')
    .select('image_index, storage_path, media_type').eq('post_id', post.id).order('image_index');
  const images = (media || []).filter(m => /^image\//.test(m.media_type || 'image/jpeg'));
  if (!images.length) return finish('filtered_out', 1, 'no_image');
  counts.stage1_pass = 1;

  // Stage 2 — caption text.
  const fromShowTag = !!post.hint_show_id || await isActiveShowTag(db, post.source_hashtag);
  const verdict = captionFilter(post.caption_clean, { fromShowTag });
  const prefilter = { ...(post.prefilter || {}), stage1: { pass: true }, stage2: verdict };
  if (!verdict.pass) return finish('filtered_out', 2, verdict.reason, { prefilter });
  counts.stage2_pass = 1;

  // Stage 3 — cheap image triage on the first image. A triage failure (null)
  // lets the post through rather than dropping a possible sale.
  const { data: blob } = await db.storage.from(EVIDENCE_BUCKET).download(images[0].storage_path);
  let triage = null;
  if (blob) {
    triage = await triageImage({ base64: Buffer.from(await blob.arrayBuffer()).toString('base64'), mediaType: images[0].media_type || 'image/jpeg' });
  }
  prefilter.stage3 = triage;
  const statedSold = captionAmounts(post.caption_clean).length > 0;
  if (triage && !(triage.oneSlab && (triage.priceVisible || statedSold))) {
    return finish('filtered_out', 3, !triage.oneSlab ? 'not_one_slab' : 'no_price_visible', { prefilter });
  }
  counts.stage3_pass = 1;
  return finish('queued', null, null, { prefilter });
}

// Call before querying a hashtag on Instagram. False = the account's
// 30-unique-tags-per-7-days cap is reached; don't query.
async function claimHashtagSlot(db, tag, igAccount = process.env.SOCIAL_IG_ACCOUNT || 'cardshow.io') {
  const { data, error } = await db.rpc('claim_hashtag_slot', { p_tag: tag, p_ig_account: igAccount });
  if (error) { console.warn('[social] claim_hashtag_slot failed:', error.message); return false; }
  return data === true;
}

async function bumpYield(db, tag, counts) {
  if (!tag) return;
  await db.rpc('bump_hashtag_yield', { p_tag: lc(tag).replace(/^#/, ''), p_day: isoDate(new Date()), p_counts: counts });
}

module.exports = {
  DISCOVERY_METHODS, CATEGORY_SUBCATEGORIES, normalizeGrade, normalizeYear, resolveCategory,
  categoryFromPsa, buildCardTitle, prefilterPost, isActiveShowTag, claimHashtagSlot,
  EXTRACT_MODEL, TRIAGE_MODEL, EVIDENCE_BUCKET, RETENTION_DAYS, GRADERS, FINAL, CRITICAL_FIELDS,
  json, getDb, sha256, norm, lc, numOrNull, isoDate, addDays,
  requireAdmin, isPipelineCall, siteBase, kickStage,
  parsePostUrl, postKeyFor, cleanCaption,
  captionAmounts, captionAskSoldPattern, captionFilter,
  extractPost, triageImage, processExtraction, normalizeGrader, normalizeCert,
  lookupCert, cardMatch, recoverPartialCert, stolenCheck,
  compMedian, sanityFlag,
  showRange, attributeShow, resolveSoldDate,
  PRICE_SCORE, certScore, overallScore, isAutoEligible, autoApproveGate,
  findSameSale, samePrice, publishExtraction, maybeSchedulePurge, bumpYield,
};
