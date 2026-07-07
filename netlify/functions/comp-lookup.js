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

// ── CARDSIGHT CATALOG SCORING ──
// Scores catalog results against seller card attributes; returns best match
// or null when no result clears the minimum confidence threshold.
//
// Point values:
//   Year match         40 pts  (year mismatch is disqualifying — card is skipped)
//   Set/release        up to 30 pts (10 per matching word, capped)
//   Solo player        15 pts  (multi-player cards penalised -5 per slash)
//   ROOKIE attribute   +15/-5 pts
//   AUTO attribute     +10/-10 pts
//   Card number        10 pts exact / 5 pts partial
//   REFRACTOR          +10 pts
//   PATCH/RELIC/JERSEY +10 pts
//   League code        +10 pts match / -15 pts wrong league
//   Player in name     5 pts
// Minimum threshold: 40 pts (year must match).

function scoreCatalogMatch(results, card) {
  if (!results || !results.length) return null;

  const targetYear     = String(card.year || '').trim();
  const targetSet      = (card.cardSet || '').toLowerCase();
  const targetNumber   = (card.cardNumber || '').toLowerCase().trim();
  const targetParallel = (card.parallel || '').toLowerCase();
  const targetPlayer   = (card.player || '').toLowerCase().trim();
  const targetTitle    = (card.cardTitle || '').toLowerCase();

  const setWords = targetSet
    .replace(/^\d{4}[-\s]*/, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  let bestScore = -1;
  let bestCard  = null;

  for (const c of results) {
    let score = 0;

    // Year match (40 pts) — mismatch is disqualifying
    if (targetYear && String(c.releaseYear) === targetYear) {
      score += 40;
    } else if (targetYear) {
      continue;
    }

    // Release/set name match (up to 30 pts, 10 per matching word)
    const combined = ((c.releaseName || '') + ' ' + (c.setName || '')).toLowerCase();
    let setScore = 0;
    for (const word of setWords) {
      if (combined.includes(word)) setScore += 10;
    }
    score += Math.min(setScore, 30);

    // Single-player bonus (15 pts); penalise multi-player (-5 per slash)
    const slashes = (c.name || '').split('/').length - 1;
    score += slashes === 0 ? 15 : slashes * -5;

    // Card number match (10 pts exact / 5 pts partial)
    if (targetNumber && c.number) {
      const cNum = c.number.toLowerCase().trim();
      if (cNum === targetNumber) score += 10;
      else if (cNum.includes(targetNumber) || targetNumber.includes(cNum)) score += 5;
    }

    const attrs = c.attributes || [];

    // AUTO (+10 match / -10 mismatch)
    const sellerIsAuto =
      targetParallel.includes('auto') || targetTitle.includes('auto');
    if (sellerIsAuto && attrs.includes('AUTO'))  score += 10;
    if (sellerIsAuto && !attrs.includes('AUTO')) score -= 10;

    // ROOKIE (+15 match / -5 mismatch)
    const sellerIsRookie =
      /\brc\b/i.test(targetTitle) || /rookie/i.test(targetTitle) ||
      /\brc\b/i.test(targetParallel) || /rookie/i.test(targetParallel);
    if (sellerIsRookie && attrs.includes('ROOKIE'))  score += 15;
    if (sellerIsRookie && !attrs.includes('ROOKIE')) score -= 5;

    // REFRACTOR (+10)
    if (targetParallel.includes('refractor') && attrs.includes('REFRACTOR')) score += 10;

    // PATCH / RELIC / JERSEY (+10)
    const sellerHasPatch =
      targetParallel.includes('patch') ||
      targetParallel.includes('relic') ||
      targetParallel.includes('jersey');
    if (sellerHasPatch &&
        (attrs.includes('PATCH') || attrs.includes('RELIC') || attrs.includes('JERSEY'))) {
      score += 10;
    }

    // League code match (+10) / wrong league (-15)
    const leagueMap = {
      'baseball': 'MLB', 'basketball': 'NBA',
      'football': 'NFL', 'hockey': 'NHL', 'soccer': 'MLS',
    };
    const targetLeague = leagueMap[(card.sport || '').toLowerCase()];
    if (targetLeague) {
      if (attrs.some(a => a.startsWith(targetLeague))) score += 10;
      const wrongLeague = Object.values(leagueMap)
        .filter(l => l !== targetLeague)
        .some(l => attrs.some(a => a.startsWith(l)));
      if (wrongLeague) score -= 15;
    }

    // Player name present in card name (5 pts)
    if (targetPlayer && (c.name || '').toLowerCase().includes(targetPlayer)) score += 5;

    if (process.env.CARDSHOW_DEBUG) {
      console.log(`[cardsight score] ${score} | ${c.name} | ${c.releaseName} ${c.releaseYear} | #${c.number}`);
    }

    if (score > bestScore) {
      bestScore = score;
      bestCard  = c;
    }
  }

  const MINIMUM_SCORE = 40;
  if (bestScore < MINIMUM_SCORE) {
    if (process.env.CARDSHOW_DEBUG) {
      console.log(`[cardsight] best score ${bestScore} below threshold ${MINIMUM_SCORE} — no match`);
    }
    return null;
  }

  if (process.env.CARDSHOW_DEBUG) {
    console.log(`[cardsight] selected: ${bestCard?.name} (score ${bestScore})`);
  }

  return bestCard;
}

// ── CARDSIGHT AI LOOKUP ──
// Primary source for sports cards. Two-step flow:
//   Step 1: GET /v1/catalog/cards?name= → card UUID
//           (Support confirmed: name= is the correct param, not player=)
//   Step 2: GET /v1/pricing/{card_id}?period=90d&listing_type=both → sale records
// Free tier: 750 calls/month. 24h price_cache TTL limits redundant calls.

async function lookupCardSight(card) {
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
    // name= confirmed by CardSight support (player= was the incorrect SDK doc param).
    const searchParams = new URLSearchParams();
    if (card.player) searchParams.set('name', card.player);
    searchParams.set('take', '10');

    // Pass set name hint to help narrow results — CardSight may support release=
    if (card.cardSet) {
      const setHint = card.cardSet.replace(/^\d{4}[-\s]*/, '').trim();
      if (setHint) searchParams.set('release', setHint);
    }

    const searchRes = await fetch(
      `https://api.cardsight.ai/v1/catalog/cards?${searchParams}`,
      { headers, signal: AbortSignal.timeout(6000) }
    );

    if (!searchRes.ok) {
      console.warn(`[cardsight] catalog search failed: ${searchRes.status}`);
      return { stub: true };
    }

    const searchData = await searchRes.json();

    if (process.env.CARDSHOW_DEBUG)
      console.log('[cardsight catalog]', JSON.stringify(searchData, null, 2));

    // VERIFY: response array field name from Swagger — keeping fallback chain
    const cards = searchData?.cards
      || searchData?.data
      || searchData?.results
      || [];

    if (!cards.length) {
      console.warn(`[cardsight] no catalog match for: "${card.player}"`);
      return { stub: true, noData: true };
    }

    // Score all catalog results and pick the best match by year + set + player signals.
    const matched = scoreCatalogMatch(cards, card);
    if (!matched) {
      console.warn(`[cardsight] no scored match for "${card.player}" in ${cards.length} results`);
      return { stub: true, noData: true };
    }

    const cardId = matched?.id ?? matched?.uuid ?? matched?.card_id;
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
      console.log('[cardsight pricing]', JSON.stringify(pricingData, null, 2));

    // ── Extract the right price tier by grade ────────────────────────────────
    const gradeNum  = parseFloat(card.grade) || 0;
    let compPrice   = null;
    let recentSales = [];

    // Helper: map a raw records array to the normalised sale shape,
    // filtering to completed transactions only (not BIN asking prices).
    function mapRecords(records) {
      if (!Array.isArray(records)) return [];
      return records
        .filter(r => {
          // VERIFY: listing_type values for completed sales from Swagger
          // Include record if field absent (older data), or if it indicates a sale
          const lt = r?.listing_type ?? r?.type ?? '';
          return !lt || lt === 'sold' || lt === 'completed' || lt === 'auction' || lt === 'fixed';
        })
        .slice(0, 5)
        .map(r => ({
          price:  Number(r?.price ?? r?.sold_price ?? r?.amount ?? 0),
          date:   r?.date ?? r?.sold_date ?? r?.created_at ?? null,             // VERIFY
          source: r?.source ?? r?.marketplace ?? 'CardSight',                   // VERIFY
          url:    r?.url ?? r?.listing_url ?? r?.source_url ?? null,            // VERIFY
          image:  r?.image_url ?? r?.image ?? r?.card_image ?? null,            // VERIFY
        }))
        .filter(r => r.price > 0);
    }

    // VERIFY: graded section field name from Swagger (currently 'graded')
    if (gradeNum > 0 && pricingData?.graded?.length) {
      const graderName = (card.grader || 'PSA').toUpperCase();

      // VERIFY: grading company field name (currently 'company_name')
      const company = pricingData.graded.find(
        c => (c?.company_name ?? c?.grader ?? c?.label ?? '').toUpperCase() === graderName
      ) || pricingData.graded[0];

      if (company?.grades?.length) {
        // VERIFY: grade value field name (currently 'grade_value')
        const gradeMatch = company.grades.find(
          g => parseFloat(g?.grade_value ?? g?.grade ?? g?.label ?? g?.value) === gradeNum
        ) || company.grades.find(
          g => Math.abs(parseFloat(g?.grade_value ?? g?.grade ?? g?.label ?? g?.value) - gradeNum) <= 0.5
        );

        // VERIFY: sale records field name within a grade entry (currently 'records')
        recentSales = mapRecords(gradeMatch?.records ?? gradeMatch?.sales ?? []);
      }
    }

    // Fall back to raw (ungraded) sales if no graded records found
    if (!recentSales.length) {
      // VERIFY: raw section field name from Swagger (currently 'raw')
      const rawRecords = pricingData?.raw?.records
        ?? pricingData?.raw?.sales
        ?? pricingData?.records
        ?? [];
      recentSales = mapRecords(rawRecords);
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
