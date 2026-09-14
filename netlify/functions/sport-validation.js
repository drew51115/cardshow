// sport-validation.js — PriceCharting-based sport validation pass
//
// Backs the seller inventory toolbar's "🏷️ Validate Sport" button. Only ever
// called for cards where detectSport() (app.html) already returned '—' —
// i.e. the player-name lookup and set/brand fallback both came up empty.
// Those cards are the fundamentally unscalable gap in a hand-maintained
// player-name list (see "Sport Classification — imported Sport field
// override" in CLAUDE.md): a real player CardShow doesn't happen to have
// hardcoded, on a set CardShow's brand-keyword fallback doesn't recognize.
//
// PriceCharting's `console-name` field on a matched product carries an
// explicit sport category string (e.g. "Baseball Cards", "Football Cards")
// — the same field comp-lookup.js's pcSportCategory()/scorePCResult()
// already parse for sport cross-checking during comp pricing. This reuses
// that exact signal for the opposite direction: given a card with no known
// sport, resolve one from a matched product's own category tag instead of
// guessing from player/set text.
//
// POST { player, year, cardSet, cardNumber, parallel }
// Returns { success: true, sport: 'Baseball'|... | null, tier: 'high'|'none', source: 'pricecharting' }
//
// Deliberately narrower than comp-lookup.js's full PriceCharting flow: no
// price fetch (fetchPCPrices), no grade-tier selection — only the search +
// score step, since all this needs is the winning product's console-name.
//
// buildPCQuery/scorePCResult are duplicated (not shared) from
// comp-lookup.js and card-correction.js — both are file-local, unexported
// functions there, so there's no shared module to import from in this
// no-build-step app. This copy is the card-correction.js variant (no sport
// scoring term), not the comp-lookup.js variant (which scores +20/-40 on a
// sport match) — scoring on sport here would be circular, since sport is
// exactly what this function exists to resolve. Keep in sync if either
// source file's scoring logic changes.

const PC_TIMEOUT_MS = 4000;

// Sport words PriceCharting's console-name may carry as a category prefix/
// suffix (e.g. "2017 Topps Baseball Cards") — same set trading-card-lookup.js's
// SPORT_PREFIX_RE/SPORT_SUFFIX_RE already recognize. Only the sports CardShow
// actually has a badge for are mapped; golf/tennis/boxing/mma/wrestling/
// racing/generic "sports" are recognized-but-unmapped on purpose — better to
// report no match than invent a CardShow sport label that doesn't exist.
const SPORT_WORD_RE = /\b(baseball|football|basketball|hockey|soccer|pokemon)\b/i;
const SPORT_LABEL = {
  baseball:   'Baseball',
  football:   'Football',
  basketball: 'Basketball',
  hockey:     'Hockey',
  soccer:     'Soccer',
  pokemon:    'Pokemon',
};

function buildPCQuery(card) {
  const parts = [card.player || '', card.year ? String(card.year) : '', card.cardSet || '']
    .map(s => s.trim()).filter(Boolean);
  const num = (card.cardNumber || '').trim();
  if (num && /^\d+$/.test(num)) parts.push(num);
  return parts.join(' ').trim();
}

// Score a PriceCharting result against the seller's card — bracket/number/
// year/subset terms only, no sport term (see file header for why).
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

// Extract a CardShow sport label from a matched product's console-name.
// Returns null (not a guess) when no recognized sport word is present —
// e.g. a console-name of just "Topps Chrome" with no category suffix at all.
function extractSportFromConsoleName(consoleName) {
  const match = (consoleName || '').match(SPORT_WORD_RE);
  if (!match) return null;
  return SPORT_LABEL[match[1].toLowerCase()] || null;
}

async function lookupSportFromPriceCharting(card) {
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
    console.warn('[sport-validation] PriceCharting request failed:', err.message);
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

  // Same "require a real positive signal" bar as card-correction.js's
  // PriceCharting fallback — PriceCharting's catalog is less structured
  // than a purpose-built sports-card database, so a weak match isn't
  // trusted to carry a sport classification that gets written to the DB
  // and shown to buyers.
  if (!best || bestScore < 20) return { available: true, tier: 'none' };

  const sport = extractSportFromConsoleName(best['console-name']);
  if (!sport) return { available: true, tier: 'none' };

  return { available: true, tier: 'high', sport, source: 'pricecharting' };
}

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
    cardSet:    body.cardSet    || '',
    cardNumber: body.cardNumber || '',
    parallel:   body.parallel   || '',
  };

  if (!card.player.trim() && !card.cardSet.trim()) {
    // Nothing to search PriceCharting with — no API call spent.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sport: null, tier: 'none', source: null }),
    };
  }

  try {
    const result = await lookupSportFromPriceCharting(card);

    if (!result.available) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'pricecharting_unavailable', sport: null, tier: 'none' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        sport:   result.tier === 'high' ? result.sport : null,
        tier:    result.tier,
        source:  result.tier === 'high' ? result.source : null,
      }),
    };
  } catch (err) {
    console.error('[sport-validation] unexpected error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'server_error', message: 'Sport validation lookup failed' }),
    };
  }
};
