// comp-lookup.js — CardSight AI + PriceCharting + Pokémon TCG API + TCG API
// Routing:
//   Pokemon     → pokemontcg.io, fallback to TCG API
//   Other TCG   → TCG API
//   Sports      → CardSight AI (primary), fallback to PriceCharting
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
      stub:         false,
      compPrice:    data.comp_price,
      lowPrice:     data.low_price   || null,
      highPrice:    data.high_price  || null,
      recentSales:  [],
      source:       data.source,
      fromCache:    true,
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

// ── CARDSIGHT AI LOOKUP ──
// Primary source for sports cards. Two-step flow:
//   Step 1: GET /v1/catalog/cards?player=&year=&manufacturer= → card UUID
//   Step 2: GET /v1/pricing/{card_id}?period=90d&listing_type=both → sale records
// Free tier: 750 calls/month. 24h price_cache TTL limits redundant calls.

// Helper: map common set names to CardSight's manufacturer parameter
function inferManufacturer(cardSet) {
  const s = (cardSet || '').toLowerCase();
  if (s.includes('topps') || s.includes('bowman'))         return 'Topps';
  if (s.includes('panini') || s.includes('prizm') ||
      s.includes('donruss') || s.includes('select') ||
      s.includes('mosaic')  || s.includes('contenders'))   return 'Panini';
  if (s.includes('upper deck') || s.includes('ud '))       return 'Upper Deck';
  if (s.includes('fleer'))                                  return 'Fleer';
  if (s.includes('score'))                                  return 'Score';
  return null; // omit manufacturer filter if unknown
}

async function lookupCardSight(card) {
  // DISABLED: CardSight catalog search ignores all filter params (player=, q=, etc.)
  // and returns random MTG/Garbage Pail Kids cards regardless of input. The endpoint
  // does not match the SDK docs. Re-enable once CardSight support confirms correct params.
  // Contact: cardsight.ai — reference this issue: player= param not filtering results.
  return { stub: true };

  // eslint-disable-next-line no-unreachable
  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) {
    console.warn('[cardsight] CARDSIGHT_API_KEY not set');
    return { stub: true };
  }

  const headers = {
    'X-API-Key':    apiKey,
    'Content-Type': 'application/json',
  };

  try {
    // ── STEP 1: Catalog search to get card UUID ──────────────────────────────
    // Use player= param per CardSight SDK spec. Pass player name only —
    // adding year/manufacturer sends mixed-sport noise that surfaces MTG cards.
    const searchParams = new URLSearchParams();
    if (card.player) searchParams.set('player', card.player);
    searchParams.set('take', '3');

    const searchRes = await fetch(
      `https://api.cardsight.ai/v1/catalog/cards?${searchParams}`,
      { headers, signal: AbortSignal.timeout(6000) }
    );

    if (!searchRes.ok) {
      console.warn(`[cardsight] catalog search failed: ${searchRes.status}`);
      return { stub: true };
    }

    const searchData = await searchRes.json();
    const cards = searchData?.cards || searchData?.data || [];

    if (process.env.CARDSHOW_DEBUG)
      console.log('[cardsight] catalog results:', JSON.stringify(cards.slice(0, 2), null, 2));

    if (!cards.length) {
      console.warn(`[cardsight] no catalog match for: "${card.player}"`);
      return { stub: true, noData: true };
    }

    // Validate: for sports cards the name field IS the player name.
    // Reject results where name doesn't match — catches MTG/TCG bleed-through.
    const playerLower = (card.player || '').toLowerCase();
    const matched = cards.find(c =>
      typeof c.name === 'string' && c.name.toLowerCase().includes(playerLower)
    );
    if (!matched) {
      console.warn(`[cardsight] no match for "${card.player}" — got name="${cards[0]?.name}" set="${cards[0]?.releaseName}"`);
      return { stub: true, noData: true };
    }

    const cardId = matched.id;
    if (!cardId) return { stub: true, noData: true };

    // ── STEP 2: Pricing lookup by UUID ───────────────────────────────────────
    const pricingParams = new URLSearchParams({
      period:       '90d',
      listing_type: 'both',
      limit:        '25',
    });

    const pricingRes = await fetch(
      `https://api.cardsight.ai/v1/pricing/${cardId}?${pricingParams}`,
      { headers, signal: AbortSignal.timeout(6000) }
    );

    if (!pricingRes.ok) {
      console.warn(`[cardsight] pricing failed: ${pricingRes.status}`);
      return { stub: true };
    }

    const pricingData = await pricingRes.json();
    if (process.env.CARDSHOW_DEBUG)
      console.log('[cardsight] pricing:', JSON.stringify(pricingData, null, 2));

    // ── Extract the right price tier by grade ────────────────────────────────
    const gradeNum  = parseFloat(card.grade) || 0;
    let compPrice   = null;
    let recentSales = [];

    if (gradeNum > 0 && pricingData.graded?.length) {
      const graderName = (card.grader || 'PSA').toUpperCase();
      const company = pricingData.graded.find(
        c => c.company_name?.toUpperCase() === graderName
      ) || pricingData.graded[0];

      if (company?.grades?.length) {
        const gradeMatch = company.grades.find(
          g => parseFloat(g.grade_value) === gradeNum
        ) || company.grades.find(
          g => Math.abs(parseFloat(g.grade_value) - gradeNum) <= 0.5
        );

        if (gradeMatch?.records?.length) {
          recentSales = gradeMatch.records
            .slice(0, 5)
            .map(r => ({
              price:  Number(r.price),
              date:   r.date   || null,
              source: r.source || 'CardSight',
            }))
            .filter(r => r.price > 0);
        }
      }
    } else if (pricingData.raw?.records?.length) {
      // Ungraded — use raw sales
      recentSales = pricingData.raw.records
        .slice(0, 5)
        .map(r => ({
          price:  Number(r.price),
          date:   r.date   || null,
          source: r.source || 'CardSight',
        }))
        .filter(r => r.price > 0);
    }

    if (recentSales.length) {
      const prices = recentSales.map(r => r.price).sort((a, b) => a - b);
      const mid    = Math.floor(prices.length / 2);
      compPrice    = prices.length % 2 !== 0
        ? prices[mid]
        : (prices[mid - 1] + prices[mid]) / 2;
    }

    if (!compPrice) return { stub: true, noData: true };

    const allPrices = recentSales.map(r => r.price);
    return {
      stub:        false,
      compPrice,
      lowPrice:    allPrices.length ? Math.min(...allPrices) : null,
      highPrice:   allPrices.length ? Math.max(...allPrices) : null,
      recentSales: recentSales.slice(0, 3),
      source:      'cardsight',
      matchedCard: matched.name || card.player,
    };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('[cardsight] timeout');
    } else {
      console.warn('[cardsight] error:', err.message);
    }
    return { stub: true };
  }
}

// ── PRICECHARTING LOOKUP ──
// Fallback for sports cards when CardSight returns no result.
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
      stub:         false,
      compPrice,
      lowPrice:     null,
      highPrice:    null,
      recentSales:  [],
      source:       'pricecharting',
      matchedCard:  product.name,
      productId:    String(product.id),
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

    const SUBTYPE_ORDER = [
      'holofoil', 'reverseHolofoil', '1stEditionHolofoil',
      'normal', '1stEditionNormal',
    ];

    for (const item of cards) {
      const prices = item.tcgplayer?.prices || {};
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
          stub:        false,
          compPrice,
          lowPrice,
          highPrice,
          recentSales: [],
          source:      'pokemontcg',
          cardName:    item.name,
          setName:     item.set?.name || null,
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
      stub:        false,
      compPrice:   Number(compPrice),
      lowPrice:    item.low_price  ? Number(item.low_price)  : null,
      highPrice:   item.high_price ? Number(item.high_price) : null,
      recentSales: [],
      source:      'tcgapi',
      cardName:    item.name || item.card_name || null,
      setName:     item.set  || item.set_name  || null,
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
// Pokemon     → pokemontcg.io, fallback to TCG API
// Other TCG   → TCG API
// Sports      → CardSight AI (primary), fallback to PriceCharting

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
    // Sports: CardSight AI primary, PriceCharting fallback
    result = await lookupCardSight(card);
    if (!result || result.stub || !result.compPrice) {
      console.log('CardSight miss — falling back to PriceCharting');
      result = await lookupPriceCharting(card);
    }
  }

  if (result && !result.stub && result.compPrice) {
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
