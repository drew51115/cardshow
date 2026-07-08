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
      parallelId:   data.parallel_id || null,
      cardId:       data.card_id     || null,
      fromCache:    true,
    };
  } catch {
    return null;
  }
}

// Read stale/expired cache row for just the CardSight IDs.
// Used on cache miss to skip catalog search + parallel resolution on the next live call.
// Does NOT filter by fetched_at — the IDs are stable catalog data.
async function getCachedIds(card) {
  const db = getDb();
  if (!db) return {};

  const fp = buildFingerprint(card);
  try {
    const { data } = await db
      .from('price_cache')
      .select('card_id, parallel_id')
      .eq('card_fingerprint', fp)
      .maybeSingle();
    if (!data) return {};
    return { cardId: data.card_id || null, parallelId: data.parallel_id || null };
  } catch {
    return {};
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
      low_price:   result.lowPrice   || null,
      high_price:  result.highPrice  || null,
      source:      result.source,
      fetched_at:  new Date().toISOString(),
      parallel_id: result.parallelId || null,
      card_id:     result.cardId     || null,
    }, { onConflict: 'card_fingerprint' });
  } catch (err) {
    console.warn('Cache write failed:', err.message);
  }
}

// ── CARDSIGHT CATALOG HELPERS ──

// Map set name to CardSight's releaseName= keyword.
// CardSight does partial case-insensitive match on this field.
// IMPORTANT: more specific strings must come before less specific ones.
// "Topps Chrome Update" is a distinct release from "Topps Chrome" in CardSight's catalog.
function extractReleaseName(cardSet) {
  const s = (cardSet || '').toLowerCase().replace(/^\d{4}[-\s]*/, '');
  const signatures = [
    // Topps Chrome variants — most specific first
    ['topps chrome update sapphire', 'Topps Chrome Update Sapphire Edition'],
    ['chrome update sapphire',       'Topps Chrome Update Sapphire Edition'],
    ['topps chrome update',          'Topps Chrome Update'],
    ['chrome update',                'Topps Chrome Update'],
    // Bowman Chrome before bare Bowman
    ['bowman chrome draft',          'Bowman Chrome Draft'],
    ['bowman chrome',                'Bowman Chrome'],
    ['topps chrome',                 'Topps Chrome'],
    ['chrome',                       'Topps Chrome'],  // fallback for bare "Chrome"
    // Bowman variants
    ['bowman platinum',              'Bowman Platinum'],
    ['bowman sterling',              'Bowman Sterling'],
    ["bowman's best",                "Bowman's Best"],
    ['bowman',                       'Bowman'],
    // Prizm variants
    ['prizm draft picks',            'Prizm Draft Picks'],
    ['prizm draft',                  'Prizm Draft'],
    ['panini prizm',                 'Prizm'],
    ['prizm',                        'Prizm'],
    // Other Panini
    ['donruss optic',                'Donruss Optic'],
    ['panini contenders optic',      'Panini Contenders Optic'],
    ['panini contenders',            'Panini Contenders'],
    ['select',                       'Select'],
    ['donruss',                      'Donruss'],
    ['panini chronicles',            'Chronicles'],
    // Topps product lines
    ['topps update',                 'Topps Update'],
    ['topps series 2',               'Topps Series 2'],
    ['topps series 1',               'Topps Series 1'],
    ['topps heritage',               'Topps Heritage'],
    ['topps finest',                 'Topps Finest'],
    ['topps stadium club',           'Stadium Club'],
    ['topps pro debut',              'Topps Pro Debut'],
    ['topps',                        'Topps'],
    // Other
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

// Map card fields to CardSight attributeShortName codes (case-sensitive).
// AU is returned first — it's more specific and higher-priority for pricing.
function deriveAttributeShortNames(card) {
  const combined = ((card.cardTitle || '') + ' ' + (card.parallel || '')).toLowerCase();
  const attrs = [];
  if (combined.includes('auto') || /\bau\b/.test(combined)) attrs.push('AU');
  if (/\brc\b/.test(combined) || combined.includes('rookie'))  attrs.push('RC');
  return attrs;
}

// Build URLSearchParams for a catalog search attempt.
// Attempt 1: number= only (isolated — combining with other filters causes 500s)
// Attempt 2: releaseName= + attributeShortName= (no number)
// Attempt 3: releaseName= only (no attribute)
// Attempt 4: name + year only — broadest fallback
// Attempt 1 is skipped automatically when no card number is present.
function buildCardSightParams(card, attempt) {
  const params  = new URLSearchParams();
  if (card.player) params.set('name', card.player);
  if (card.year)   params.set('year', String(card.year));

  const release = card.cardSet ? extractReleaseName(card.cardSet) : null;
  const attrs   = deriveAttributeShortNames(card);

  if (attempt === 1) {
    // number= isolated — no other filters to avoid server-side 500s
    params.set('number', card.cardNumber.trim());
    params.set('take', '5');
  } else if (attempt === 2) {
    if (release) params.set('releaseName', release);
    if (attrs.length) params.set('attributeShortName', attrs[0]);
    params.set('take', '10');
  } else if (attempt === 3) {
    if (release) params.set('releaseName', release);
    params.set('take', '15');
  } else {
    params.set('take', '25');
  }

  params.set('sort',  'name');
  params.set('order', 'asc');
  return params;
}

// Tiebreaker for multiple results already pre-filtered by year/release/attribute.
// Results here are expected to be 2-10 cards, not hundreds.
function scoreCatalogMatch(results, card) {
  if (!results?.length) return null;

  const targetNumber = (card.cardNumber || '').toLowerCase().trim();
  const targetPlayer = (card.player     || '').toLowerCase().trim();

  // Fast path: exact card number match
  if (targetNumber) {
    const exact = results.find(c => c.number?.toLowerCase().trim() === targetNumber);
    if (exact) {
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardsight] exact number match:', exact.name);
      return exact;
    }
  }

  let bestScore = -1;
  let bestCard  = null;

  for (const c of results) {
    let score = 0;

    // Solo card preferred over multi-player
    const slashes = (c.name || '').split('/').length - 1;
    if (slashes === 0) score += 20;
    else               score -= slashes * 8;

    // Player name in card name
    if (targetPlayer && (c.name || '').toLowerCase().includes(targetPlayer)) score += 10;

    // Partial card number match
    if (targetNumber && c.number) {
      const cNum = c.number.toLowerCase().trim();
      if (cNum.includes(targetNumber) || targetNumber.includes(cNum)) score += 8;
    }

    if (process.env.CARDSHOW_DEBUG) {
      console.log(`[cardsight score] ${score} | ${c.name} | #${c.number}`);
    }

    if (score > bestScore) {
      bestScore = score;
      bestCard  = c;
    }
  }

  // No minimum threshold — results already pre-filtered before scoring
  return bestCard || results[0];
}

// ── CARDSIGHT AI LOOKUP ──
// Primary source for sports cards. Three-step flow:
//   Step 1: GET /v1/catalog/cards?name= → card UUID
//           (Support confirmed: name= is the correct param, not player=)
//           Skipped when cached.cardId is provided.
//   Step 2: GET /v1/catalog/cards/{id} → all parallels for the card
//           Match seller's parallel to get parallel_id.
//           Skipped when cached.parallelId is provided OR no parallel specified.
//   Step 3: GET /v1/pricing/{id}?parallel_id=&period=... → sale records
//           period=all for numbered ≤100; period=90d otherwise.
// Free tier: 750 calls/month. 24h price_cache TTL limits redundant calls.

async function lookupCardSight(card, cached = {}) {
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
    // Skip when a cached card_id is available — saves 1-4 API calls.
    // Up to 4 tiered attempts, progressively broader. number= is isolated in
    // attempt 1 because combining it with releaseName= / attributeShortName=
    // triggers 500s for certain card numbers (e.g. RA-PS, BPA-PS2).
    // 401/429 break the loop; 500/404 use continue to try next tier.
    let selectedCard = null;
    let cardId       = cached.cardId || null;
    let matchedName  = null;

    if (!cardId) {
      const hasNumber = card.cardNumber && card.cardNumber.trim().length > 1;

      for (let attempt = 1; attempt <= 4; attempt++) {
        if (attempt === 1 && !hasNumber) continue;

        const searchParams = buildCardSightParams(card, attempt);
        const searchUrl    = `https://api.cardsight.ai/v1/catalog/cards?${searchParams}`;

        if (process.env.CARDSHOW_DEBUG)
          console.log(`[cardsight] attempt ${attempt}:`, searchUrl);

        const searchRes = await fetch(searchUrl, {
          headers,
          signal: AbortSignal.timeout(6000),
        });

        if (!searchRes.ok) {
          console.warn(`[cardsight] attempt ${attempt} failed: ${searchRes.status}`, searchUrl);
          try {
            const errBody = await searchRes.text();
            console.warn('[cardsight] error body:', errBody);
          } catch { /* ignore */ }
          if (searchRes.status === 401 || searchRes.status === 429) break;
          continue;
        }

        const searchData = await searchRes.json();
        const results    = searchData?.cards || searchData?.data || [];

        if (process.env.CARDSHOW_DEBUG) {
          console.log(`[cardsight] attempt ${attempt} returned`, results.length,
            'results (total:', searchData?.total_count, ')');
          results.forEach(c =>
            console.log(' -', c.name, '|', c.releaseName, c.releaseYear, '| #', c.number));
        }

        if (!results.length) continue;

        selectedCard = results.length === 1
          ? results[0]
          : scoreCatalogMatch(results, card);

        if (selectedCard) {
          if (process.env.CARDSHOW_DEBUG)
            console.log('[cardsight] selected:', selectedCard.name, '| id:', selectedCard.id);
          break;
        }
      }

      if (!selectedCard?.id) {
        if (process.env.CARDSHOW_DEBUG) console.log('[cardsight] no match after all attempts');
        return { stub: true, noData: true };
      }

      cardId      = selectedCard.id;
      matchedName = selectedCard.name;
    } else {
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardsight] using cached cardId:', cardId);
    }

    // ── STEP 2: Parallel resolution ─────────────────────────────────────────
    // GET /v1/catalog/cards/{id} → list of parallels with ids.
    // Only runs when seller has a parallel AND we don't have a cached parallelId.
    let parallelId = cached.parallelId || null;

    if (!parallelId && card.parallel && card.parallel.trim()) {
      try {
        const detailRes = await fetch(
          `https://api.cardsight.ai/v1/catalog/cards/${cardId}`,
          { headers, signal: AbortSignal.timeout(4000) }
        );

        if (detailRes.ok) {
          const detail    = await detailRes.json();
          const parallels = detail.parallels ?? detail.card?.parallels ?? [];

          if (process.env.CARDSHOW_DEBUG) {
            console.log('[cardsight] parallels available:',
              parallels.map(p => `${p.name} (${p.id ?? p.parallel_id})`));
          }

          const sellerPStr = card.parallel.toLowerCase()
            .replace(/\/\d+/g, '')
            .replace(/refractor/gi, '')
            .trim();
          const sellerWords = sellerPStr.split(/\s+/).filter(w => w.length > 2);
          const sellerRun   = (card.parallel.match(/\/(\d+)/) || [])[1];

          let bestPScore = 0;
          let bestP      = null;

          for (const p of parallels) {
            const pName = (p.name || '').toLowerCase()
              .replace(/refractor/gi, '')
              .trim();
            let pScore = 0;
            for (const w of sellerWords) {
              if (pName.includes(w)) pScore++;
            }
            const pRun = (p.name.match(/\/(\d+)/) || [])[1];
            if (sellerRun && pRun && sellerRun === pRun) pScore += 3;

            if (pScore > bestPScore) { bestPScore = pScore; bestP = p; }
          }

          if (bestP && bestPScore > 0) {
            parallelId = bestP.id ?? bestP.parallel_id ?? null;
            if (process.env.CARDSHOW_DEBUG)
              console.log('[cardsight] parallel matched:', bestP.name, '→', parallelId);
          } else if (process.env.CARDSHOW_DEBUG) {
            console.log('[cardsight] no parallel match for:', card.parallel);
          }
        }
      } catch (err) {
        console.warn('[cardsight] parallel lookup failed:', err.message);
      }
    } else if (!card.parallel?.trim() && process.env.CARDSHOW_DEBUG) {
      console.log('[cardsight] no parallel specified — skipping detail call');
    }

    // ── STEP 3: Pricing lookup ───────────────────────────────────────────────
    // period=all for numbered ≤100 (scarce parallels may have very few 90d sales).
    const printRun = parseInt((card.parallel || '').match(/\/(\d+)/)?.[1] || '9999');
    const period   = printRun <= 100 ? 'all' : '90d';

    const pricingParams = new URLSearchParams({
      period,
      listing_type: 'both',
      limit:        '25',
    });
    if (parallelId) pricingParams.set('parallel_id', parallelId);

    if (process.env.CARDSHOW_DEBUG) {
      console.log('[cardsight] period:', period, '| parallelId:', parallelId || 'none (aggregate)');
      console.log('[cardsight] pricing url:', `https://api.cardsight.ai/v1/pricing/${cardId}?${pricingParams}`);
    }

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

    // Filter to completed sales, score by parallel match, sort, and normalise.
    // Records whose parallel_name matches the seller's parallel variant float
    // to the top; within the same score, most recent sales come first.
    const sellerParallel = (card.parallel || '').toLowerCase();
    const sellerRunMatch = sellerParallel.match(/\/(\d+)/);
    const sellerRun      = sellerRunMatch ? sellerRunMatch[1] : null;
    const parallelWords  = sellerParallel
      .replace(/\/\d+/, '')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 2);

    function scoreAndSortRecords(records) {
      if (!Array.isArray(records)) return [];

      const completed = records.filter(r => {
        const lt = r?.listing_type ?? r?.type ?? '';
        return !lt || lt === 'sold' || lt === 'completed' || lt === 'auction' || lt === 'fixed';
      });

      const scored = completed.map(r => {
        const recParallel = (r?.parallel_name || '').toLowerCase();
        let matchScore = 0;

        if (sellerParallel && recParallel) {
          for (const word of parallelWords) {
            if (recParallel.includes(word)) matchScore += 10;
          }
          // Bonus for matching print run (/50, /150 etc.)
          const recRunMatch = recParallel.match(/\/(\d+)/)
                           || (r?.title || '').match(/\/(\d+)/);
          const recRun = recRunMatch ? recRunMatch[1] : null;
          if (sellerRun && recRun && sellerRun === recRun) matchScore += 20;
        }

        return { ...r, _matchScore: matchScore };
      });

      scored.sort((a, b) =>
        b._matchScore !== a._matchScore
          ? b._matchScore - a._matchScore
          : new Date(b.date || b.sold_date || 0) - new Date(a.date || a.sold_date || 0)
      );

      return scored.slice(0, 5).map(r => ({
        price:        Number(r?.price ?? r?.sold_price ?? r?.amount ?? 0),
        date:         r?.date ?? r?.sold_date ?? r?.created_at ?? null,
        source:       r?.source ?? r?.marketplace ?? 'CardSight',
        url:          r?.url ?? r?.listing_url ?? r?.source_url ?? null,
        image:        r?.image_url ?? r?.image ?? r?.card_image ?? null,
        parallelName: r?.parallel_name || null,
      })).filter(r => r.price > 0);
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
        recentSales = scoreAndSortRecords(gradeMatch?.records ?? gradeMatch?.sales ?? []);
      }
    }

    // Fall back to raw (ungraded) sales if no graded records found
    if (!recentSales.length) {
      // VERIFY: raw section field name from Swagger (currently 'raw')
      const rawRecords = pricingData?.raw?.records
        ?? pricingData?.raw?.sales
        ?? pricingData?.records
        ?? [];
      recentSales = scoreAndSortRecords(rawRecords);
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
      matchedCard: matchedName || card.player,
      parallelId:  parallelId || null,
      cardId:      cardId     || null,
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
//
// Confirmed field names from official sportscardspro API docs:
//   PSA 10 → manual-only-price   BGS 10 → bgs-10-price
//   CGC 10 → condition-17-price  SGC 10 → condition-18-price
//   Grade 9 → graded-price       Grade 8/8.5 → new-price
//   Grade 7/7.5 → cib-price      Ungraded → loose-price

function buildPCQuery(card) {
  const parts = [
    card.player  || '',
    card.year    ? String(card.year) : '',
    card.cardSet || '',
  ].map(s => s.trim()).filter(Boolean);

  // Only append card number when purely numeric — alphanumeric prospect codes
  // (BPA-PS2, RA-PS, WLA-1, RCPA-PS) are not in PriceCharting's index and
  // cause false matches on unrelated cards that happen to share the substring.
  const num = (card.cardNumber || '').trim();
  if (num && /^\d+$/.test(num)) parts.push(num);

  return parts.join(' ').trim();
}

// Fetch price data for a given PriceCharting product ID.
// Extracted so the empty-price retry can call it for a different product.
async function fetchPCPrices(token, productId) {
  await waitForPCRateLimit();
  const res = await fetch(
    `https://www.sportscardspro.com/api/product?t=${token}&id=${productId}`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

function selectPCPrice(p, card) {
  const gradeNum = parseFloat(card.grade) || 0;
  const grader   = (card.grader || '').toUpperCase();

  if (gradeNum >= 10) {
    if (grader === 'BGS') return p['bgs-10-price'];
    if (grader === 'CGC') return p['condition-17-price'];
    if (grader === 'SGC') return p['condition-18-price'];
    return p['manual-only-price'];  // PSA 10 and default
  }
  if (gradeNum >= 9.5) return p['box-only-price'];
  if (gradeNum >= 9)   return p['graded-price'];
  if (gradeNum >= 7)   return p['new-price'];
  if (gradeNum > 0)    return p['cib-price'];
  return p['loose-price'];
}

async function lookupPriceCharting(card) {
  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) {
    console.warn('PRICECHARTING_TOKEN not set — returning stub');
    return { stub: true };
  }

  try {
    const query = buildPCQuery(card);
    if (!query) return { stub: true };

    if (process.env.CARDSHOW_DEBUG) console.log('[PC] query:', query);

    await waitForPCRateLimit();

    const searchRes = await fetch(
      `https://www.sportscardspro.com/api/products?t=${token}&q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(6000) }
    );

    if (!searchRes.ok) {
      console.warn('PriceCharting search failed:', searchRes.status);
      return { stub: true };
    }

    let products = (await searchRes.json())?.products || [];

    if (process.env.CARDSHOW_DEBUG) {
      console.log('[PC] products returned:', products.length);
      if (products.length) {
        console.log('[PC] best match:', products[0]['product-name'],
          '|', products[0]['console-name']);
      }
    }

    // Retry with simplified query (player + year only) when set name causes a miss
    if (!products.length) {
      const simpleQuery = [card.player, card.year].filter(Boolean).join(' ').trim();
      if (simpleQuery && simpleQuery !== query) {
        if (process.env.CARDSHOW_DEBUG) console.log('[PC] retrying with simplified query:', simpleQuery);
        await waitForPCRateLimit();
        const retryRes = await fetch(
          `https://www.sportscardspro.com/api/products?t=${token}&q=${encodeURIComponent(simpleQuery)}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (retryRes.ok) products = (await retryRes.json())?.products || [];
      }
    }

    let product = products[0];
    if (!product?.id) return { stub: true, noData: true };

    let priceData = await fetchPCPrices(token, product.id);
    if (!priceData || priceData.status === 'error') return { stub: true, noData: true };

    // Check if the matched product actually has any price data
    const PC_PRICE_FIELDS = [
      'loose-price', 'graded-price', 'new-price', 'cib-price',
      'manual-only-price', 'bgs-10-price', 'condition-17-price', 'condition-18-price',
    ];
    const hasPriceData = PC_PRICE_FIELDS.some(f => priceData[f] && priceData[f] > 0);

    if (!hasPriceData) {
      if (process.env.CARDSHOW_DEBUG) {
        console.log('[PC] no price data for matched card:',
          priceData['product-name'] || product['product-name']);
        console.log('[PC] retrying with simplified query');
      }
      // The set name may have matched the wrong card — retry with player + year only
      const simpleQuery = [card.player, card.year].filter(Boolean).join(' ').trim();
      if (simpleQuery && simpleQuery !== query) {
        await waitForPCRateLimit();
        const retryRes = await fetch(
          `https://www.sportscardspro.com/api/products?t=${token}&q=${encodeURIComponent(simpleQuery)}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (retryRes.ok) {
          const retryProducts = (await retryRes.json())?.products || [];
          if (retryProducts[0]?.id && retryProducts[0].id !== product.id) {
            product   = retryProducts[0];
            priceData = await fetchPCPrices(token, product.id);
            if (!priceData || priceData.status === 'error') return { stub: true, noData: true };
          }
        }
      }
    }

    const rawPennies = selectPCPrice(priceData, card);

    if (process.env.CARDSHOW_DEBUG) {
      console.log('[PC] price data:', JSON.stringify({
        'manual-only-price': priceData['manual-only-price'],
        'graded-price':      priceData['graded-price'],
        'loose-price':       priceData['loose-price'],
        'bgs-10-price':      priceData['bgs-10-price'],
      }));
      console.log('[PC] selected price (pennies):', rawPennies);
    }

    // 0 means no data for that grade tier, not a $0 card
    if (!rawPennies || rawPennies <= 0) {
      const fallback = priceData['loose-price'];
      if (!fallback || fallback <= 0) return { stub: true, noData: true };
      return {
        stub:          false,
        compPrice:     fallback / 100,
        lowPrice:      null,
        highPrice:     null,
        recentSales:   [],
        source:        'pricecharting',
        matchedCard:   priceData['product-name'] || product['product-name'],
        gradeFallback: true,
      };
    }

    return {
      stub:        false,
      compPrice:   rawPennies / 100,
      lowPrice:    null,
      highPrice:   null,
      recentSales: [],
      source:      'pricecharting',
      matchedCard: priceData['product-name'] || product['product-name'],
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
    // Sports: CardSight AI primary, PriceCharting fallback.
    // On cache miss, read stale cached IDs to skip catalog search + parallel resolution.
    const cachedIds = await getCachedIds(card);
    result = await lookupCardSight(card, cachedIds);
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
