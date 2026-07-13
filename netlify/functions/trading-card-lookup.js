// Netlify Function: trading-card-lookup
// POST { query: string, sport: string|null }
// Returns normalized card results for autocomplete.
//
// Routing (in priority order):
//   1. TRADING_CARD_API_KEY set → Trading Card API (all sports + TCG, 3M+ cards)
//   2. No TRADING_CARD_API_KEY, CARDSIGHT_API_KEY set →
//      CardSight catalog (sports) + Pokémon TCG API run in PARALLEL,
//      results merged (sports first). CardSight covers MLB/NFL/NBA/NHL.
//   3. No CARDSIGHT_API_KEY → Pokémon TCG API + PriceCharting run in PARALLEL,
//      results merged (Pokémon first). Eliminates fragile keyword detection —
//      pokemontcg.io returns [] for sports queries; PriceCharting returns [] for TCG.
//   4. Neither API available → stub (local CARD_DB fallback in client)
//
// Results cached in card_search_cache (Supabase) for 7 days.
// Cache key prefix: "tradingcardapi:" / "cardsight:" / "auto:" (parallel mode)
// Cache writes are non-blocking — a write failure never breaks the response.

const { createClient } = require('@supabase/supabase-js');

const TCG_API_BASE      = 'https://api.tradingcardapi.com/v1/cards';
const POKEMON_API_BASE  = 'https://api.pokemontcg.io/v2/cards';
const PC_API_BASE       = 'https://www.sportscardspro.com/api/products';
const CARDSIGHT_API_BASE = 'https://api.cardsight.ai/v1';
const TIMEOUT_MS        = 4000;
const POKEMON_TIMEOUT_MS = 3000; // Pokémon TCG runs in parallel; fail fast if it lags
const CACHE_TTL_DAYS    = 7;

// Sports that use Trading Card API exclusively when TRADING_CARD_API_KEY is set
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

// ── POKÉMON TCG API LOOKUP ──
// pokemontcg.io — returns fully structured card data including set, number, rarity, image

async function lookupPokemonTCG(query) {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  // API works without a key (rate-limited); key raises the limit
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  // Build a pokemontcg.io query — search by card name
  // The API uses Lucene-style queries: name:"charizard*" finds all Charizard cards
  const nameQuery = `name:"${query.trim().replace(/"/g, '')}*"`;
  const params = new URLSearchParams({
    q:        nameQuery,
    pageSize: '8',
    orderBy:  '-set.releaseDate', // newest sets first
    select:   'id,name,set,number,rarity,images,supertype,subtypes',
  });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), POKEMON_TIMEOUT_MS);

  try {
    const res = await fetch(`${POKEMON_API_BASE}?${params.toString()}`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn('[trading-card-lookup] Pokémon TCG API error:', res.status);
      return null;
    }

    const data  = await res.json();
    const cards = Array.isArray(data?.data) ? data.data : [];
    if (!cards.length) return [];

    return cards.map(c => ({
      id:         c.id,
      player:     c.name || '',
      year:       c.set?.releaseDate ? c.set.releaseDate.slice(0, 4) : '',
      cardSet:    c.set?.name || '',
      cardNumber: c.number || null,
      sport:      'Pokemon',
      parallel:   [
        ...(c.subtypes || []),
        c.rarity ? c.rarity : null,
      ].filter(Boolean).join(' · ') || null,
      imageUrl:   c.images?.small || c.images?.large || null,
      rawTitle:   null,
    }));

  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[trading-card-lookup] Pokémon TCG error:', err.message);
    return null;
  }
}

// ── CARDSIGHT CATALOG SEARCH ──
// Uses the same catalog endpoint as comp-lookup.js but for autocomplete.
// Returns normalized card objects for sports cards (MLB/NFL/NBA/NHL).
// Pokémon/TCG queries naturally return [] — safe to run in parallel with Pokémon TCG API.

async function lookupCardSightCatalog(query) {
  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const params = new URLSearchParams({ name: query, take: '8' });
    const res = await fetch(`${CARDSIGHT_API_BASE}/catalog/cards?${params.toString()}`, {
      signal:  controller.signal,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn('[trading-card-lookup] CardSight catalog error:', res.status);
      return null;
    }

    const data  = await res.json();
    // CardSight wraps results under the 'cards' key (confirmed from comp-lookup.js)
    const items = data?.cards || data?.data || data?.results || [];
    if (!items.length) return [];

    // Log first item to diagnose actual field names in CardSight catalog response
    if (items.length > 0) {
      console.log('[trading-card-lookup] CardSight catalog first item keys:', Object.keys(items[0]));
      console.log('[trading-card-lookup] CardSight catalog first item:', JSON.stringify(items[0]));
    }

    return items.map(c => {
      const id         = String(c.id ?? c.uuid ?? c.card_id ?? Math.random());
      // CardSight catalog: name = player name, releaseName = set, releaseYear = year
      // (field names confirmed from comp-lookup.js usage)
      const player     = c.name ?? c.player_name ?? c.player ?? c.playerName ?? '';
      const year       = String(c.releaseYear ?? c.release_year ?? c.year ?? '');
      const cardSet    = c.releaseName ?? c.release_name ?? c.set_name ?? c.set ?? '';
      const cardNumber = c.number ?? c.card_number ?? null;
      const parallel   = c.parallel_name ?? c.parallel ?? null;
      const sport      = c.sport ?? c.league ?? null;
      const imageUrl   = c.image_url ?? c.image ?? c.front_image ?? null;

      console.log('[trading-card-lookup] CardSight mapped:', { player, year, cardSet, cardNumber });
      return { id, player, year, cardSet, cardNumber: cardNumber ? String(cardNumber) : null, sport, parallel, imageUrl, rawTitle: null };
    }).filter(c => c.player); // drop entries with no player name

  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[trading-card-lookup] CardSight catalog error:', err.message);
    return null;
  }
}

// ── PRICECHARTING NAME PARSER ──
// PriceCharting names follow two common patterns:
//   A) "Baseball Cards 2026 Topps Chrome Aaron Judge Gold Refractor"  (console-name: "Topps Chrome")
//   B) "Aaron Judge 2026 Topps Chrome Gold Refractor"                  (console-name: "Topps Chrome")
// console-name often has a sport suffix: "2017 Topps Baseball Cards" → strip to "2017 Topps"

const SPORT_PREFIX_RE  = /^(baseball|football|basketball|hockey|soccer|golf|tennis|boxing|mma|wrestling|racing|sports?)\s+cards?\s*/i;
const SPORT_SUFFIX_RE  = /\s*(baseball|football|basketball|hockey|soccer|golf|tennis|boxing|mma|wrestling|racing|sports?)\s+cards?$/i;

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
  const rawName     = (product.name            || '').trim();
  const consoleName = (product['console-name'] || '').trim();

  const fullName = rawName.replace(SPORT_PREFIX_RE, '').trim();
  // Strip sport category from both ends of console-name so
  // "2017 Topps Baseball Cards" → "2017 Topps" (not left as-is or empty).
  const cardSet  = consoleName.replace(SPORT_PREFIX_RE, '').replace(SPORT_SUFFIX_RE, '').trim();

  const yearMatch = fullName.match(/\b(19|20)\d{2}\b/);
  const year      = yearMatch ? yearMatch[0] : '';

  let player  = '';
  let parallel = null;

  if (year) {
    const yearIdx    = fullName.indexOf(year);
    const beforeYear = fullName.slice(0, yearIdx).trim();
    const afterYear  = fullName.slice(yearIdx + year.length).trim();

    if (beforeYear) {
      // Player precedes the year
      player = beforeYear;
      const afterSet = cardSet
        ? afterYear.replace(new RegExp(cardSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
        : afterYear;
      const m = afterSet.match(PARALLEL_RE) || [];
      parallel = [...new Set(m.map(t => t.trim()))].join(' ') || null;
    } else if (cardSet) {
      // Year first; player is after the known set name
      const afterSet = afterYear
        .replace(new RegExp(cardSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
        .trim();
      const m = afterSet.match(PARALLEL_RE) || [];
      parallel = [...new Set(m.map(t => t.trim()))].join(' ') || null;
      player   = afterSet.replace(PARALLEL_RE, '').replace(/\s+/g, ' ').trim();
    } else {
      // Year first + no usable cardSet: skip the first word (likely brand like "Topps")
      // and treat the rest (minus parallels) as the player name.
      const words = afterYear.split(/\s+/);
      const afterBrand = words.slice(1).join(' ').trim();
      const m = afterBrand.match(PARALLEL_RE) || [];
      parallel = [...new Set(m.map(t => t.trim()))].join(' ') || null;
      const candidate = afterBrand.replace(PARALLEL_RE, '').replace(/\s+/g, ' ').trim();
      // Only use if it looks like a name (2+ chars, no digits except card#)
      if (candidate.length > 1 && !/^\d+$/.test(candidate)) player = candidate;
    }
  } else {
    const m = fullName.match(PARALLEL_RE) || [];
    parallel = [...new Set(m.map(t => t.trim()))].join(' ') || null;
    player   = fullName.replace(PARALLEL_RE, '').replace(/\s+/g, ' ').trim();
  }

  return {
    id:         String(product.id),
    player,
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
    return products.length ? products.map(parsePCProduct) : [];

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
  const q         = query.trim();

  // ── 1. Trading Card API (covers everything when key is set) ──
  if (tcgApiKey) {
    const queryKey = buildQueryKey(q, 'tradingcardapi');
    const cached   = await readSearchCache(queryKey);
    if (cached) {
      return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
    }

    const params = new URLSearchParams({ 'filter[name]': q, 'page[limit]': '8' });
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
        return respond({ stub: false, results: [], error: `API error ${res.status}` });
      }

      const data    = await res.json();
      const results = (Array.isArray(data?.data) ? data.data : []).map(r => ({
        id:         r.id,
        player:     r.attributes?.name         || '',
        year:       r.attributes?.year         ? String(r.attributes.year) : '',
        cardSet:    r.attributes?.set_name     || '',
        cardNumber: r.attributes?.card_number  || null,
        sport:      r.attributes?.sport        || null,
        parallel:   r.attributes?.parallel     || null,
        imageUrl:   r.attributes?.image_url    || null,
      }));

      writeSearchCache(queryKey, results, 'tradingcardapi').catch(() => {});
      return respond({ stub: false, results, fromCache: false, source: 'tradingcardapi' });

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') return respond({ stub: false, results: [], error: 'timeout' });
      console.error('[trading-card-lookup] TCG fetch error:', err.message);
      return respond({ stub: false, results: [], error: err.message });
    }
  }

  // ── 2. CardSight catalog (sports) + Pokémon TCG API run simultaneously ──
  // CardSight covers MLB/NFL/NBA/NHL; pokemontcg.io covers Pokémon.
  // Each returns [] for the other's domain — safe to merge.
  if (process.env.CARDSIGHT_API_KEY) {
    const queryKey = buildQueryKey(q, 'cs2');
    const cached   = await readSearchCache(queryKey);
    if (cached) {
      return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
    }

    const [csResults, pokemonResults] = await Promise.all([
      lookupCardSightCatalog(q),
      lookupPokemonTCG(q),
    ]);

    // Merge: sports (CardSight) first, then Pokémon, dedupe by id, cap at 8
    const seen    = new Set();
    const results = [...(csResults || []), ...(pokemonResults || [])]
      .filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      })
      .slice(0, 8);

    if (results.length > 0) {
      writeSearchCache(queryKey, results, 'cs2').catch(() => {});
      return respond({ stub: false, results, fromCache: false, source: 'cardsight' });
    }
    // Fall through to PriceCharting if both returned nothing
  }

  // ── 3. Parallel mode: Pokémon TCG API + PriceCharting run simultaneously ──
  // No keyword detection — pokemontcg.io returns [] for sports queries and
  // PriceCharting returns [] for TCG queries, so merging is safe and correct.
  const queryKey = buildQueryKey(q, 'auto');
  const cached   = await readSearchCache(queryKey);
  if (cached) {
    return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
  }

  const [pokemonResults, pcResults] = await Promise.all([
    lookupPokemonTCG(q),
    lookupPriceCharting(q),
  ]);

  // Merge: Pokémon results first, then sports cards, dedupe by id, cap at 8
  const seen    = new Set();
  const results = [...(pokemonResults || []), ...(pcResults || [])]
    .filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .slice(0, 8);

  // Only use these results if at least one entry has a real player name.
  // PriceCharting often returns set-level products with no extractable player —
  // in that case stub=true so the client uses the local CARD_DB.
  const usableResults = results.filter(r => r.player);
  if (usableResults.length > 0) {
    writeSearchCache(queryKey, usableResults, 'auto').catch(() => {});
    return respond({ stub: false, results: usableResults, fromCache: false, source: 'auto' });
  }

  // All APIs returned nothing useful — stub so client falls back to local CARD_DB
  return respond({ stub: true, results: [] });
};

function respond(payload) {
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify(payload),
  };
}
