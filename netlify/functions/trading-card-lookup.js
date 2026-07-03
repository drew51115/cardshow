// Netlify Function: trading-card-lookup
// POST { query: string, sport: string|null }
// Returns normalized card results for autocomplete.
//
// Routing (in priority order):
//   1. TRADING_CARD_API_KEY set → Trading Card API (all sports + TCG, 3M+ cards)
//   2. Query looks like Pokémon + POKEMON_TCG_API_KEY set → Pokémon TCG API (pokemontcg.io)
//   3. Non-TCG sport + PRICECHARTING_TOKEN set → PriceCharting search fallback
//   4. Anything else → stub (local CARD_DB fallback in client)
//
// Results cached in card_search_cache (Supabase) for 7 days.
// Cache key prefix: "tradingcardapi:", "pokemontcg:", or "pricecharting:"
// Cache writes are non-blocking — a write failure never breaks the response.

const { createClient } = require('@supabase/supabase-js');

const TCG_API_BASE     = 'https://api.tradingcardapi.com/v1/cards';
const POKEMON_API_BASE = 'https://api.pokemontcg.io/v2/cards';
const PC_API_BASE      = 'https://www.sportscardspro.com/api/products';
const TIMEOUT_MS       = 5000;
const CACHE_TTL_DAYS   = 7;

// Sports that route to Trading Card API (not PriceCharting) when TRADING_CARD_API_KEY is set
const TCG_SPORTS = new Set([
  'Pokemon', 'MTG', 'Magic', 'Yu-Gi-Oh',
  'Lorcana', 'One Piece', 'Dragon Ball',
  'Digimon', 'Flesh and Blood',
]);

// Keywords that indicate a Pokémon query when no sport field is sent
const POKEMON_KEYWORDS = [
  'pokemon', 'charizard', 'pikachu', 'mewtwo', 'eevee', 'gengar', 'snorlax',
  'blastoise', 'venusaur', 'rayquaza', 'lugia', 'ho-oh', 'umbreon', 'espeon',
  'vaporeon', 'jolteon', 'flareon', 'sylveon', 'glaceon', 'leafeon',
  'scarlet', 'violet', 'obsidian', 'paldea', 'temporal', 'prismatic',
  'evolving skies', 'brilliant stars', 'silver tempest', 'crown zenith',
  'paldean fates', 'paradox rift', 'twilight masquerade',
  'ex ', ' ex', ' vmax', ' vstar', ' gx', ' v ', ' v$',
  'holo rare', 'ultra rare', 'secret rare', 'rainbow rare',
];
const POKEMON_RE = new RegExp(POKEMON_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

function looksLikePokemon(query, sport) {
  if (sport === 'Pokemon') return true;
  return POKEMON_RE.test(query);
}

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
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

// ── PRICECHARTING NAME PARSER ──
// PriceCharting names follow two common patterns:
//   A) "Baseball Cards 2026 Topps Chrome Aaron Judge Gold Refractor"  (console-name: "Topps Chrome")
//   B) "Aaron Judge 2026 Topps Chrome Gold Refractor"                  (console-name: "Topps Chrome")

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
  const rawName     = (product.name            || '').trim();
  const consoleName = (product['console-name'] || '').trim();

  const fullName = rawName.replace(SPORT_PREFIX_RE, '').trim();
  const cardSet  = consoleName.replace(SPORT_PREFIX_RE, '').trim();

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
    }
    // Year first + no usable cardSet → can't isolate player; leave empty, rawTitle used as fallback
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

  const tcgApiKey  = process.env.TRADING_CARD_API_KEY;
  const pokemonKey = process.env.POKEMON_TCG_API_KEY;
  const isPokemon  = looksLikePokemon(query.trim(), sport);
  const isTCG      = TCG_SPORTS.has(sport);

  // ── 1. Trading Card API (covers everything when key is set) ──
  if (tcgApiKey) {
    const queryKey = buildQueryKey(query.trim(), 'tradingcardapi');
    const cached   = await readSearchCache(queryKey);
    if (cached) {
      return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
    }

    const params = new URLSearchParams({ 'filter[name]': query.trim(), 'page[limit]': '8' });
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

  // ── 2. Pokémon TCG API (pokemontcg.io) — for Pokémon queries ──
  if (isPokemon) {
    const queryKey = buildQueryKey(query.trim(), 'pokemontcg');
    const cached   = await readSearchCache(queryKey);
    if (cached) {
      return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
    }

    const results = await lookupPokemonTCG(query.trim());
    if (results && results.length > 0) {
      writeSearchCache(queryKey, results, 'pokemontcg').catch(() => {});
      return respond({ stub: false, results, fromCache: false, source: 'pokemontcg' });
    }
    if (results !== null) {
      // API responded but no matches
      return respond({ stub: false, results: [], source: 'pokemontcg' });
    }
    // null = API unavailable → fall through to stub
    console.warn('[trading-card-lookup] Pokémon TCG API unavailable — returning stub');
    return respond({ stub: true, results: [] });
  }

  // ── 3. PriceCharting fallback (non-TCG sports cards) ──
  if (!isTCG) {
    const queryKey = buildQueryKey(query.trim(), 'pricecharting');
    const cached   = await readSearchCache(queryKey);
    if (cached) {
      return respond({ stub: false, results: cached.results, fromCache: true, source: cached.source });
    }

    const results = await lookupPriceCharting(query.trim());
    if (results) {
      writeSearchCache(queryKey, results, 'pricecharting').catch(() => {});
      return respond({ stub: false, results, fromCache: false, source: 'pricecharting' });
    }
  }

  // ── 4. Stub — TCG sports without any key, or all APIs failed ──
  return respond({ stub: true, results: [] });
};

function respond(payload) {
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify(payload),
  };
}
