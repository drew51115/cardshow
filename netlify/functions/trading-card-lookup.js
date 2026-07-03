// Netlify Function: trading-card-lookup
// POST { query: string, sport: string|null }
// Returns normalized card results for autocomplete.
//
// Routing:
//   TRADING_CARD_API_KEY set → Trading Card API (all sports, 3M+ cards)
//   No TRADING_CARD_API_KEY, PRICECHARTING_TOKEN set, non-TCG sport → PriceCharting search fallback
//   TCG sport (Pokemon, MTG, etc.) without TRADING_CARD_API_KEY → stub (local CARD_DB fallback)
//
// Results cached in card_search_cache (Supabase) for 7 days.
// Cache key prefix: "tradingcardapi:" or "pricecharting:" depending on source.
// Cache writes are non-blocking — a write failure never breaks the response.

const { createClient } = require('@supabase/supabase-js');

const TCG_API_BASE   = 'https://api.tradingcardapi.com/v1/cards';
const PC_API_BASE    = 'https://www.sportscardspro.com/api/products';
const TIMEOUT_MS     = 5000;
const CACHE_TTL_DAYS = 7;

const TCG_SPORTS = new Set([
  'Pokemon', 'MTG', 'Magic', 'Yu-Gi-Oh',
  'Lorcana', 'One Piece', 'Dragon Ball',
  'Digimon', 'Flesh and Blood',
]);

// ── CACHE HELPERS ──

function buildQueryKey(rawQuery, source) {
  const normalized = rawQuery.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${source}:${normalized}`;
}

function getDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function readSearchCache(queryKey) {
  const db = getDb();
  if (!db) return null;

  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data } = await db
      .from('card_search_cache')
      .select('results, source')
      .eq('query_key', queryKey)
      .gte('fetched_at', cutoff)
      .maybeSingle();

    if (!data) return null;
    return { results: data.results, source: data.source };
  } catch {
    return null;
  }
}

async function writeSearchCache(queryKey, results, source) {
  const db = getDb();
  if (!db) return;

  try {
    await db.from('card_search_cache').upsert({
      query_key:  queryKey,
      results,
      source,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'query_key' });
  } catch (err) {
    console.warn('[trading-card-lookup] cache write failed:', err.message);
  }
}

// ── PRICECHARTING NAME PARSER ──
// PriceCharting names follow two common patterns:
//   A) "Baseball Cards 2026 Topps Chrome Aaron Judge Gold Refractor"
//      console-name: "Topps Chrome"
//   B) "Aaron Judge 2026 Topps Chrome Gold Refractor"
//      console-name: "Topps Chrome"
//
// Strategy:
//   1. Strip leading sport-category prefix ("Baseball Cards", "Football Cards", etc.)
//   2. Split on year — text before year is player (pattern B), text after is set+variant
//   3. If nothing before year, player is after the console-name set name
//   4. Use console-name as cardSet; strip it from parallel remnant

// Sport category prefixes PriceCharting prepends to some product names
const SPORT_PREFIX_RE = /^(baseball|football|basketball|hockey|soccer|golf|tennis|boxing|mma|wrestling|racing|sports?)\s+cards?\s*/i;

const PARALLEL_TERMS = [
  'refractor', 'prizm', 'auto', 'autograph', 'rookie', 'rc',
  'gold', 'silver', 'red', 'blue', 'green', 'orange', 'purple',
  'black', 'white', 'pink', 'yellow', 'holo', 'foil', 'chrome',
  'wave', 'cracked ice', 'atomic', 'superfractor', 'numbered',
  'variation', 'short print', 'sp', 'ssp', 'sse', 'insert',
  'patch', 'relic', 'jersey', 'bat', 'base',
];
const PARALLEL_RE = new RegExp(`\\b(${PARALLEL_TERMS.join('|')})\\b`, 'gi');

function parsePCProduct(product) {
  const rawName     = (product.name             || '').trim();
  const consoleName = (product['console-name']  || '').trim();

  // Strip leading sport-category prefix before parsing
  const fullName = rawName.replace(SPORT_PREFIX_RE, '').trim();

  // Year: first 4-digit year-like number
  const yearMatch = fullName.match(/\b(19|20)\d{2}\b/);
  const year      = yearMatch ? yearMatch[0] : '';

  // cardSet from console-name, also strip its sport prefix
  const cardSet = consoleName.replace(SPORT_PREFIX_RE, '').trim();

  let player  = '';
  let parallel = null;

  if (year) {
    const yearIdx  = fullName.indexOf(year);
    const beforeYear = fullName.slice(0, yearIdx).trim();
    const afterYear  = fullName.slice(yearIdx + year.length).trim();

    if (beforeYear) {
      // Pattern B: player name precedes the year
      player = beforeYear;
      // Parallel = after-year content minus the set name
      const afterSet = cardSet
        ? afterYear.replace(new RegExp(cardSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
        : afterYear;
      const pMatches = afterSet.match(PARALLEL_RE) || [];
      parallel = [...new Set(pMatches.map(t => t.trim()))].join(' ') || null;
    } else {
      // Pattern A (after sport prefix stripped): year comes first
      // Player is after the set name in the after-year portion
      let afterSet = cardSet
        ? afterYear.replace(new RegExp(cardSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
        : afterYear;
      // Strip parallel/variant words — what remains is the player
      const pMatches = afterSet.match(PARALLEL_RE) || [];
      parallel = [...new Set(pMatches.map(t => t.trim()))].join(' ') || null;
      player   = afterSet.replace(PARALLEL_RE, '').replace(/\s+/g, ' ').trim();
    }
  } else {
    // No year found — best effort: strip parallels, use remainder as player
    const pMatches = fullName.match(PARALLEL_RE) || [];
    parallel = [...new Set(pMatches.map(t => t.trim()))].join(' ') || null;
    player   = fullName.replace(PARALLEL_RE, '').replace(/\s+/g, ' ').trim();
  }

  return {
    id:         String(product.id),
    player:     player || rawName,   // absolute fallback: raw product name
    year,
    cardSet,
    cardNumber: null,
    sport:      null,
    parallel,
    imageUrl:   null,
    rawTitle:   fullName,
  };
}

// ── PRICECHARTING SEARCH ──

async function lookupPriceCharting(query) {
  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) return null;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      `${PC_API_BASE}?t=${token}&q=${encodeURIComponent(query)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn('[trading-card-lookup] PriceCharting search failed:', res.status);
      return null;
    }

    const data     = await res.json();
    const products = Array.isArray(data?.products) ? data.products.slice(0, 8) : [];
    if (!products.length) return [];

    return products.map(parsePCProduct);

  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[trading-card-lookup] PriceCharting error:', err.message);
    return null;
  }
}

// ── HANDLER ──

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { query, sport } = body;
  if (!query || query.trim().length < 2) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: false, results: [] }),
    };
  }

  const tcgApiKey = process.env.TRADING_CARD_API_KEY;
  const isTCG     = TCG_SPORTS.has(sport);

  // Without Trading Card API key, TCG sports fall back to local CARD_DB stub
  if (!tcgApiKey && isTCG) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: true, results: [] }),
    };
  }

  // Determine source for cache key
  const source    = tcgApiKey ? 'tradingcardapi' : 'pricecharting';
  const queryKey  = buildQueryKey(query.trim(), source);

  // Cache read
  const cached = await readSearchCache(queryKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: false, results: cached.results, fromCache: true, source: cached.source }),
    };
  }

  // ── Trading Card API path ──
  if (tcgApiKey) {
    const params = new URLSearchParams({
      'filter[name]': query.trim(),
      'page[limit]':  '8',
    });
    if (sport) params.set('filter[sport]', sport);

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${TCG_API_BASE}?${params.toString()}`, {
        signal:  controller.signal,
        headers: { Authorization: `Bearer ${tcgApiKey}`, Accept: 'application/vnd.api+json' },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error('[trading-card-lookup] TCG API error', res.status, detail);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stub: false, results: [], error: `API error ${res.status}` }),
        };
      }

      const data  = await res.json();
      const items = Array.isArray(data?.data) ? data.data : [];
      const results = items.map(r => ({
        id:         r.id,
        player:     r.attributes?.name          || '',
        year:       r.attributes?.year          ? String(r.attributes.year) : '',
        cardSet:    r.attributes?.set_name      || '',
        cardNumber: r.attributes?.card_number   || null,
        sport:      r.attributes?.sport         || null,
        parallel:   r.attributes?.parallel      || null,
        imageUrl:   r.attributes?.image_url     || null,
      }));

      writeSearchCache(queryKey, results, 'tradingcardapi').catch(e =>
        console.warn('[trading-card-lookup] cache write error:', e.message)
      );

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stub: false, results, fromCache: false, source: 'tradingcardapi' }),
      };

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stub: false, results: [], error: 'timeout' }),
        };
      }
      console.error('[trading-card-lookup] TCG fetch error:', err.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stub: false, results: [], error: err.message }),
      };
    }
  }

  // ── PriceCharting fallback path (no TRADING_CARD_API_KEY, non-TCG) ──
  const pcResults = await lookupPriceCharting(query.trim());

  if (!pcResults) {
    // PriceCharting token missing or request failed — fall back to local CARD_DB
    console.warn('[trading-card-lookup] PriceCharting unavailable — returning stub');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: true, results: [] }),
    };
  }

  writeSearchCache(queryKey, pcResults, 'pricecharting').catch(e =>
    console.warn('[trading-card-lookup] cache write error:', e.message)
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stub: false, results: pcResults, fromCache: false, source: 'pricecharting' }),
  };
};
