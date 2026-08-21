// card-correction.js — bulk-scan raw-card identification correction pass
//
// Claude vision occasionally misreads a player's name off a raw card (e.g.
// "Cam Abrams" instead of "CJ Abrams") while still reading the card number
// correctly. This function cross-checks year+set+cardNumber (fields OCR
// handles more reliably than a stylized printed name) against CardSight's
// catalog, falling back to PriceCharting, and returns a corrected player
// name when a confident match is found.
//
// POST { player, year, set, cardNumber, parallel, skipCardSight? }
// Returns { success: true, tier: 'high'|'medium'|'none', correction: { player } | null, source }
//
// Deliberately narrow compared to comp-lookup.js's full lookupCardSight():
// only the number-only search attempt is tried (CardSight's exact-number
// fast path is the entire premise of this feature — a name-based retry
// would just search *by* the possibly-wrong name it's trying to fix), to
// stay well under Netlify's function timeout with room for a PriceCharting
// fallback in the same invocation.
//
// buildCardSightParams/scoreCatalogMatch/extractReleaseName/inferManufacturer
// (CardSight side) and buildPCQuery/scorePCResult (PriceCharting side) are
// duplicated from netlify/functions/comp-lookup.js — both files are
// unexported file-local functions there today, so there is no shared module
// to import from. Keep these in sync if that file's scoring logic changes.
// Name-extraction from a matched CardSight record's `name` field is adapted
// from netlify/functions/trading-card-lookup.js's STRIP_RE approach, which
// comp-lookup.js doesn't need since it never turns a match back into a name.

const CARDSIGHT_TIMEOUT_MS = 4000;
const PC_TIMEOUT_MS        = 3000;

// ── CardSight helpers (duplicated from comp-lookup.js:132-244) ──

function extractReleaseName(cardSet) {
  const s = (cardSet || '').toLowerCase().replace(/^\d{4}[-\s]*/, '');
  const signatures = [
    ['topps chrome update sapphire', 'Topps Chrome Update Sapphire Edition'],
    ['chrome update sapphire',       'Topps Chrome Update Sapphire Edition'],
    ['topps chrome update',          'Topps Chrome Update'],
    ['chrome update',                'Topps Chrome Update'],
    ['bowman chrome draft',          'Bowman Chrome Draft'],
    ['bowman chrome',                'Bowman Chrome'],
    ['topps chrome',                 'Topps Chrome'],
    ['chrome',                       'Topps Chrome'],
    ['bowman platinum',              'Bowman Platinum'],
    ['bowman sterling',              'Bowman Sterling'],
    ["bowman's best",                "Bowman's Best"],
    ['bowman',                       'Bowman'],
    ['prizm draft picks',            'Prizm Draft Picks'],
    ['prizm draft',                  'Prizm Draft'],
    ['panini prizm',                 'Prizm'],
    ['prizm',                        'Prizm'],
    ['donruss optic',                'Donruss Optic'],
    ['panini contenders optic',      'Panini Contenders Optic'],
    ['panini contenders',            'Panini Contenders'],
    ['select',                       'Select'],
    ['donruss',                      'Donruss'],
    ['panini chronicles',            'Chronicles'],
    ['topps update',                 'Topps Update'],
    ['topps series 2',               'Topps Series 2'],
    ['topps series 1',               'Topps Series 1'],
    ['topps heritage',               'Topps Heritage'],
    ['topps finest',                 'Topps Finest'],
    ['topps stadium club',           'Stadium Club'],
    ['topps pro debut',              'Topps Pro Debut'],
    ['topps',                        'Topps'],
    ['upper deck',                   'Upper Deck'],
    ['fleer ultra',                  'Fleer Ultra'],
    ['fleer',                        'Fleer'],
    ['score',                        'Score'],
  ];
  for (const [key, val] of signatures) {
    if (s.includes(key)) return val;
  }
  const words = s.split(/\s+/).filter(w => w.length > 3);
  return words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : null;
}

function inferManufacturer(cardSet) {
  const s = (cardSet || '').toLowerCase();
  if (s.includes('topps') || s.includes('bowman')) return 'Topps';
  if (s.includes('panini') || s.includes('prizm') || s.includes('donruss') ||
      s.includes('select') || s.includes('mosaic') || s.includes('contenders') ||
      s.includes('chronicles') || s.includes('optic'))
    return 'Panini';
  if (s.includes('upper deck') || s.includes(' ud ')) return 'Upper Deck';
  if (s.includes('fleer')) return 'Fleer';
  return null;
}

// Turn a matched CardSight catalog record's `name` field (a full card title,
// e.g. "CJ Abrams Gold Refractor") into a clean player name. Multi-player
// leader/combo cards ("A / B / C") have no single "the" player — return null
// rather than guess. Adapted from trading-card-lookup.js:234-261.
const STRIP_RE = /\b(refractor|prizm|auto|autograph|rookie|rc|gold|silver|red|blue|green|orange|purple|black|white|pink|yellow|holo|foil|chrome|wave|atomic|superfractor|variation|short\s+print|sp|ssp|insert|patch|relic|jersey|bat|base|optic|topps|bowman|panini|select|donruss|mosaic)\b/gi;

function extractPlayerFromCardSightName(name) {
  const cardName = (name || '').trim();
  if (!cardName) return null;
  if (cardName.includes(' / ')) return null; // multi-player combo card — no single player to correct to

  const cleaned = cardName.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2 || /^\d/.test(cleaned)) return null; // stripped to nothing usable or starts with a digit
  return cleaned;
}

// ── CardSight number-only search + match (adapted from comp-lookup.js:214-336) ──

async function lookupCardSightByNumber(card) {
  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) return { available: false };

  const cardNumber = (card.cardNumber || '').trim();
  if (!cardNumber) return { available: true, tier: 'none' };

  const params = new URLSearchParams();
  params.set('number', cardNumber);
  params.set('take', '5');
  params.set('sort', 'name');
  params.set('order', 'asc');

  let res;
  try {
    res = await fetch(`https://api.cardsight.ai/v1/catalog/cards?${params}`, {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CARDSIGHT_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[card-correction] CardSight request failed:', err.message);
    return { available: true, tier: 'none' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 429) {
      console.warn('[card-correction] CardSight blocked:', res.status);
      return { available: true, tier: 'none', rateLimited: true };
    }
    // 404/500 etc — card-specific, not a batch-wide condition
    return { available: true, tier: 'none' };
  }

  let data;
  try { data = await res.json(); } catch { return { available: true, tier: 'none' }; }
  const results = data?.cards || data?.data || [];
  if (!results.length) return { available: true, tier: 'none' };

  const targetNumber = cardNumber.toLowerCase();
  const exactMatches = results.filter(c => (c.number || '').toLowerCase().trim() === targetNumber);

  let matched;
  let tier;
  if (exactMatches.length === 1) {
    matched = exactMatches[0];
    tier = 'high';
  } else if (exactMatches.length > 1) {
    // Multiple releases share this number — tie-break by release name overlap
    const release = card.set ? extractReleaseName(card.set) : '';
    const releaseWords = release.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let bestScore = -1;
    for (const c of exactMatches) {
      const cRelease = (c.releaseName || '').toLowerCase();
      const score = releaseWords.filter(w => cRelease.includes(w)).length;
      if (score > bestScore) { bestScore = score; matched = c; }
    }
    tier = 'medium';
  } else {
    return { available: true, tier: 'none' };
  }

  const correctedPlayer = extractPlayerFromCardSightName(matched.name);
  if (!correctedPlayer) return { available: true, tier: 'none' };

  return { available: true, tier, player: correctedPlayer, source: 'cardsight' };
}

// ── PriceCharting search + score (duplicated from comp-lookup.js:724-738, 824-934) ──

function buildPCQuery(card) {
  const parts = [card.player || '', card.year ? String(card.year) : '', card.set || '']
    .map(s => s.trim()).filter(Boolean);
  const num = (card.cardNumber || '').trim();
  if (num && /^\d+$/.test(num)) parts.push(num);
  return parts.join(' ').trim();
}

function scorePCResult(product, card) {
  const pName    = (product['product-name'] || '').toLowerCase();
  const pConsole = (product['console-name'] || '').toLowerCase();
  let score = 0;

  const bracketMatch = (product['product-name'] || '').match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    const bracketContent = bracketMatch[1].toLowerCase();
    const sellerParallel = (card.parallel || '').toLowerCase();
    score += (sellerParallel && sellerParallel.includes(bracketContent)) ? 5 : -25;
  } else {
    score += 15;
  }

  const num = (card.cardNumber || '').trim();
  if (num) {
    if (pName.includes('#' + num.toLowerCase())) {
      score += 20;
    } else {
      const productNumMatch = pName.match(/#(\w+)/);
      const productNum = productNumMatch?.[1] || '';
      if (productNum && productNum !== num.toLowerCase()) score -= 5;
    }
  }

  const sellerYear = parseInt(card.year) || 0;
  if (sellerYear > 0) {
    const yearMatch = pConsole.match(/\b(19|20)\d{2}\b/);
    const productYear = yearMatch ? parseInt(yearMatch[0]) : 0;
    if (productYear > 0) {
      const delta = Math.abs(productYear - sellerYear);
      score += delta === 0 ? 15 : delta <= 1 ? -5 : delta <= 3 ? -15 : -30;
    }
  }

  const subsetKeywords = ['image variation', 'photo variation', 'rookie cup', 'award winner',
    'all star', 'short print', 'super short print', 'variation', 'error'];
  if (subsetKeywords.some(kw => pName.includes(kw))) score -= 15;

  return score;
}

// Turn a matched PriceCharting product-name back into a clean player name.
// Deliberately simpler than trading-card-lookup.js's parsePCProduct (which
// handles ambiguous ordering for a raw autocomplete query) — here we already
// know year+set, so we can just strip them plus parallel terms.
const PARALLEL_TERMS_RE = /\b(refractor|prizm|auto|autograph|rookie|rc|gold|silver|red|blue|green|orange|purple|black|white|pink|yellow|holo|foil|chrome|wave|atomic|superfractor|numbered|variation|short\s+print|sp|ssp|sse|insert|patch|relic|jersey|bat|base)\b/gi;

function extractPlayerFromPCProduct(product, card) {
  let name = (product['product-name'] || '').trim();
  if (!name) return null;
  name = name.split(/\s*#/)[0].trim(); // drop card number suffix
  if (card.year) name = name.replace(new RegExp(String(card.year), 'g'), '');
  if (card.set) name = name.replace(new RegExp(card.set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  name = name.replace(PARALLEL_TERMS_RE, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || /^\d/.test(name)) return null;
  return name;
}

async function lookupPriceChartingCorrection(card) {
  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) return { available: false };

  const query = buildPCQuery(card);
  if (!query) return { available: true, tier: 'none' };

  let res;
  try {
    res = await fetch(
      `https://www.sportscardspro.com/api/products?t=${token}&q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(PC_TIMEOUT_MS) }
    );
  } catch (err) {
    console.warn('[card-correction] PriceCharting request failed:', err.message);
    return { available: true, tier: 'none' };
  }

  if (!res.ok) return { available: true, tier: 'none' };

  let data;
  try { data = await res.json(); } catch { return { available: true, tier: 'none' }; }
  const products = data?.products || [];
  if (!products.length) return { available: true, tier: 'none' };

  let best = null;
  let bestScore = -Infinity;
  for (const p of products) {
    const score = scorePCResult(p, card);
    if (score > bestScore) { bestScore = score; best = p; }
  }

  // No result stood out enough to trust — PriceCharting's catalog is less
  // structured than CardSight's, so require a real positive signal.
  if (!best || bestScore < 20) return { available: true, tier: 'none' };

  const correctedPlayer = extractPlayerFromPCProduct(best, card);
  if (!correctedPlayer) return { available: true, tier: 'none' };

  return { available: true, tier: 'medium', player: correctedPlayer, source: 'pricecharting' };
}

// ── Handler ──

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'method_not_allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'invalid_json' }) };
  }

  const card = {
    player:     body.player     || '',
    year:       body.year       || '',
    set:        body.set        || '',
    cardNumber: body.cardNumber || '',
    parallel:   body.parallel   || '',
  };

  if (!card.cardNumber.trim()) {
    // No number to search by — the entire premise of this feature (number
    // uniquely identifies the card regardless of a misread name) doesn't
    // apply. Return "no match" without spending any API calls.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, tier: 'none', correction: null, source: null }),
    };
  }

  try {
    let result = { tier: 'none' };
    let rateLimited = false;

    if (!body.skipCardSight) {
      const cs = await lookupCardSightByNumber(card);
      if (cs.rateLimited) rateLimited = true;
      if (cs.available && cs.tier !== 'none') result = cs;
    }

    if (result.tier === 'none') {
      const pc = await lookupPriceChartingCorrection(card);
      if (pc.available && pc.tier !== 'none') result = pc;
    }

    // Don't "correct" a name back to what Claude already guessed
    if (result.player && result.player.trim().toLowerCase() === card.player.trim().toLowerCase()) {
      result = { tier: 'none' };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        tier: result.tier,
        correction: result.tier !== 'none' ? { player: result.player } : null,
        source: result.source || null,
        cardSightRateLimited: rateLimited,
      }),
    };
  } catch (err) {
    console.error('[card-correction] unexpected error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'server_error', message: 'Correction lookup failed' }),
    };
  }
};
