// comp-lookup.js — PriceCharting + Pokémon TCG API + TCG API comp price lookup
// Routing:
//   Pokemon     → pokemontcg.io, fallback to TCG API
//   Other TCG   → TCG API
//   Sports      → PriceCharting, fallback to TCG API if not found
//
// Rate limit: 1 call/second enforced via waitForPCRateLimit() for PriceCharting.
// Batch processing is sequential (for...of), never parallel, to respect the limit.
// Primary rate limiting for multi-card batch runs is enforced client-side in
// app.html's runCompCheck() — this function is called once per card.

const { createClient } = require('@supabase/supabase-js');

// ── RATE LIMITER ──
// Enforces 1100ms minimum gap between PriceCharting API calls.
// Resets on cold start — safe since each Netlify invocation is isolated.
let _lastPCCallTime = 0;

async function waitForPCRateLimit() {
  const now     = Date.now();
  const elapsed = now - _lastPCCallTime;
  if (elapsed < 1100) {
    await new Promise(r => setTimeout(r, 1100 - elapsed));
  }
  _lastPCCallTime = Date.now();
}

// ── TCG SPORT ROUTING ──
const TCG_SPORTS = [
  'Pokemon', 'MTG', 'Magic', 'Yu-Gi-Oh',
  'Lorcana', 'One Piece', 'Dragon Ball',
  'Digimon', 'Flesh and Blood',
];

// ── CACHE HELPERS ──

function buildFingerprint(card) {
  return [card.player, card.year, card.cardSet, card.cardNumber, card.parallel, card.grade, card.grader]
    .map(v => String(v || '').toLowerCase().trim())
    .join('|');
}

function getDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function checkPriceCache(card) {
  const db = getDb();
  if (!db) return null;

  const fp     = buildFingerprint(card);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data } = await db
      .from('price_cache')
      .select('*')
      .eq('card_fingerprint', fp)
      .gte('fetched_at', cutoff)
      .maybeSingle();

    if (!data) return null;
    return {
      stub:      false,
      compPrice: data.comp_price,
      lowPrice:  data.low_price  || null,
      highPrice: data.high_price || null,
      source:    data.source,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

async function writePriceCache(card, result) {
  const db = getDb();
  if (!db) return;

  const fp = buildFingerprint(card);

  try {
    await db.from('price_cache').upsert({
      card_fingerprint: fp,
      comp_price:  result.compPrice,
      low_price:   result.lowPrice  || null,
      high_price:  result.highPrice || null,
      source:      result.source,
      fetched_at:  new Date().toISOString(),
    }, { onConflict: 'card_fingerprint' });
  } catch (err) {
    console.warn('Cache write failed:', err.message);
  }
}

// ── PRICECHARTING LOOKUP ──
// Two-step: search by name to get product ID, then fetch price data by ID.
// Prices returned in pennies — divide by 100.

async function lookupPriceCharting(card) {
  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) {
    console.warn('PRICECHARTING_TOKEN not set — returning stub');
    return { stub: true };
  }

  try {
    const query = [card.player, card.year, card.cardSet, card.parallel]
      .filter(Boolean)
      .join(' ');

    await waitForPCRateLimit();

    const searchRes = await fetch(
      `https://www.sportscardspro.com/api/products?t=${token}&q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(6000) }
    );

    if (!searchRes.ok) {
      console.warn('PriceCharting search failed:', searchRes.status);
      return { stub: true };
    }

    const searchData = await searchRes.json();
    const product    = searchData?.products?.[0];
    if (!product?.id) return { stub: true, noData: true };

    await waitForPCRateLimit();

    const priceRes = await fetch(
      `https://www.sportscardspro.com/api/product?t=${token}&id=${product.id}`,
      { signal: AbortSignal.timeout(6000) }
    );

    if (!priceRes.ok) {
      console.warn('PriceCharting price fetch failed:', priceRes.status);
      return { stub: true };
    }

    const p = await priceRes.json();
    if (p.status === 'error') return { stub: true, noData: true };

    const gradeNum  = parseFloat(card.grade) || 0;
    const rawPennies =
      gradeNum >= 10 ? p['psa-10-price'] :
      gradeNum >= 9  ? p['psa-9-price']  :
      gradeNum > 0   ? p['graded-price'] :
                       p['loose-price'];

    const compPrice = (rawPennies && rawPennies > 0) ? rawPennies / 100 : null;
    if (!compPrice) return { stub: true, noData: true };

    return {
      stub:        false,
      compPrice,
      lowPrice:    null,
      highPrice:   null,
      source:      'pricecharting',
      matchedCard: product.name,
      productId:   String(product.id),
    };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('PriceCharting API timeout');
    } else {
      console.warn('PriceCharting lookup error:', err.message);
    }
    return { stub: true };
  }
}

// ── POKÉMON TCG API LOOKUP ──
// Uses pokemontcg.io v2 — returns TCGPlayer market prices.
// Optional POKEMON_TCG_API_KEY raises rate limits (free tier works without it).
// Price subtype priority: holofoil → reverseHolofoil → 1stEditionHolofoil →
//   normal → 1stEditionNormal → any available.

async function lookupPokemonTCG(card) {
  const name = (card.player || '').trim();
  if (!name) return { stub: true, noData: true };

  try {
    // Build Lucene query: match name, optionally filter by set
    const q = card.cardSet
      ? `name:"${name}" set.name:"${card.cardSet}"`
      : `name:"${name}"`;

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.POKEMON_TCG_API_KEY) {
      headers['X-Api-Key'] = process.env.POKEMON_TCG_API_KEY;
    }

    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=4&orderBy=-set.releaseDate`,
      { headers, signal: AbortSignal.timeout(6000) }
    );

    if (!res.ok) {
      console.warn('Pokemon TCG API failed:', res.status);
      return { stub: true };
    }

    const data  = await res.json();
    const cards = data.data || [];
    if (!cards.length) return { stub: true, noData: true };

    // Take the most recent card that has pricing
    for (const item of cards) {
      const prices = item.tcgplayer?.prices || {};

      // Preferred subtype order
      const SUBTYPE_ORDER = [
        'holofoil', 'reverseHolofoil', '1stEditionHolofoil',
        'normal', '1stEditionNormal',
      ];

      let compPrice = null, lowPrice = null, highPrice = null;

      for (const subtype of SUBTYPE_ORDER) {
        const p = prices[subtype];
        if (p?.market) {
          compPrice = p.market;
          lowPrice  = p.low  || null;
          highPrice = p.high || null;
          break;
        }
      }

      // Fallback: any subtype with a market price
      if (!compPrice) {
        for (const p of Object.values(prices)) {
          if (p?.market) {
            compPrice = p.market;
            lowPrice  = p.low  || null;
            highPrice = p.high || null;
            break;
          }
        }
      }

      if (compPrice) {
        return {
          stub:      false,
          compPrice,
          lowPrice,
          highPrice,
          source:    'pokemontcg',
          cardName:  item.name,
          setName:   item.set?.name || null,
        };
      }
    }

    return { stub: true, noData: true };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('Pokemon TCG API timeout');
    } else {
      console.warn('Pokemon TCG API error:', err.message);
    }
    return { stub: true };
  }
}

// ── TCG API LOOKUP ──

async function lookupTCGApi(card) {
  const apiKey = process.env.TCG_API_KEY;
  if (!apiKey) {
    console.warn('TCG_API_KEY not set — returning stub');
    return { stub: true };
  }

  try {
    const query = [card.player, card.year, card.cardSet, card.cardNumber]
      .filter(Boolean)
      .join(' ');

    const res = await fetch(
      `https://api.tcgapi.dev/v1/cards?q=${encodeURIComponent(query)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal:  AbortSignal.timeout(6000),
      }
    );

    if (!res.ok) {
      console.warn('TCG API lookup failed:', res.status);
      return { stub: true };
    }

    const data = await res.json();
    const item = data?.data?.[0] || data?.results?.[0] || data?.cards?.[0];
    if (!item) return { stub: true, noData: true };

    const compPrice = item.market_price || item.mid_price || item.price || null;
    if (!compPrice) return { stub: true, noData: true };

    return {
      stub:      false,
      compPrice: Number(compPrice),
      lowPrice:  item.low_price  ? Number(item.low_price)  : null,
      highPrice: item.high_price ? Number(item.high_price) : null,
      source:    'tcgapi',
      cardName:  item.name || item.card_name || null,
      setName:   item.set  || item.set_name  || null,
    };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('TCG API timeout');
    } else {
      console.warn('TCG API lookup error:', err.message);
    }
    return { stub: true };
  }
}

// ── ROUTER ──
// Pokemon   → pokemontcg.io, fallback to TCG API
// Other TCG → TCG API
// Sports    → PriceCharting, fallback to TCG API if not found

async function lookupComp(card) {
  const cached = await checkPriceCache(card);
  if (cached) return cached;

  const isPokemon = card.sport === 'Pokemon';
  const isTCG     = TCG_SPORTS.includes(card.sport);

  let result;

  if (isPokemon) {
    result = await lookupPokemonTCG(card);
    if (result.stub) {
      console.log('Pokemon TCG API miss — falling back to TCG API');
      result = await lookupTCGApi(card);
    }
  } else if (isTCG) {
    result = await lookupTCGApi(card);
  } else {
    // Sports card: PriceCharting first, TCG API as last resort
    result = await lookupPriceCharting(card);
    if (result.stub || result.noData) {
      console.log('PriceCharting miss — falling back to TCG API');
      result = await lookupTCGApi(card);
    }
  }

  if (!result.stub && result.compPrice) {
    await writePriceCache(card, result);
  }

  return result;
}

// ── HANDLER ──
// Processes cards SEQUENTIALLY — parallel calls would breach the
// 1 call/second PriceCharting rate limit.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let cards;
  try {
    ({ cards } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!Array.isArray(cards) || cards.length === 0) {
    return { statusCode: 400, body: 'cards array required' };
  }

  const results = [];
  for (const card of cards) {
    const result = await lookupComp(card);
    results.push({ cardId: card.id, ...result });
  }

  return {
    statusCode: 200,
    body:       JSON.stringify({ results }),
    headers:    { 'Content-Type': 'application/json' },
  };
};
