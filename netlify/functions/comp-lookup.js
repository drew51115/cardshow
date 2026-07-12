// comp-lookup.js — Card Hedge + CardSight AI + PriceCharting + Pokémon TCG API + TCG API
// Routing:
//   Pokemon     → pokemontcg.io, fallback to TCG API
//   Other TCG   → TCG API
//   Sports      → Card Hedge (primary), CardSight AI (secondary), PriceCharting (fallback)
//
// Rate limit: 1 call/second enforced via waitForPCRateLimit() for PriceCharting.
// Batch processing is sequential (for...of), never parallel, to respect the limit.
// Primary rate limiting for multi-card batch runs is enforced client-side in
// app.html's runCompCheck() — this function is called once per card.

const { createClient } = require('@supabase/supabase-js');

// ── FEATURE FLAGS ──
const CARDHEDGE_ENABLED = process.env.CARDHEDGE_ENABLED !== 'false' && !!process.env.CARDHEDGE_API_KEY;

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

// Map card set to manufacturer for catalog search narrowing.
// Prevents Topps cards from matching Panini results and vice versa.
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

  const mfr = inferManufacturer(card.cardSet);

  if (attempt === 1) {
    // number= isolated — no other filters to avoid server-side 500s
    params.set('number', card.cardNumber.trim());
    params.set('take', '5');
  } else if (attempt === 2) {
    if (release) params.set('releaseName', release);
    if (attrs.length) params.set('attributeShortName', attrs[0]);
    if (mfr) params.set('manufacturer', mfr);
    params.set('take', '10');
  } else if (attempt === 3) {
    if (release) params.set('releaseName', release);
    if (mfr) params.set('manufacturer', mfr);
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
    const exactMatches = results.filter(c =>
      c.number?.toLowerCase().trim() === targetNumber
    );

    if (exactMatches.length === 1) {
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardsight] exact number match:', exactMatches[0].name, '|', exactMatches[0].releaseName);
      return exactMatches[0];
    }

    if (exactMatches.length > 1) {
      // Multiple cards share the same number across different releases.
      // Score by releaseName to pick the right product line.
      const release  = card.cardSet ? extractReleaseName(card.cardSet) : '';
      const relLower = release.toLowerCase();
      const releaseWords = relLower.split(/\s+/).filter(w => w.length > 2);

      let bestScore = -1;
      let bestMatch = exactMatches[0];

      for (const c of exactMatches) {
        const cRelease = (c.releaseName || '').toLowerCase();
        let score = 0;
        for (const word of releaseWords) {
          if (cRelease.includes(word)) score += 10;
        }
        if (process.env.CARDSHOW_DEBUG)
          console.log(`[cardsight] number tie-break score ${score}:`, c.name, '|', c.releaseName);
        if (score > bestScore) { bestScore = score; bestMatch = c; }
      }

      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardsight] selected from tie-break:', bestMatch.name, '|', bestMatch.releaseName, '| id:', bestMatch.id);
      return bestMatch;
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

    // Penalise Draft Picks results when the seller's set doesn't reference Draft
    // Prevents Prizm Draft Picks from beating base Prizm when they share a number
    const cReleaseLower  = (c.releaseName || '').toLowerCase();
    const sellerSetLower = (card.cardSet  || '').toLowerCase();
    if (cReleaseLower.includes('draft picks') &&
        !sellerSetLower.includes('draft')) {
      score -= 30;
      if (process.env.CARDSHOW_DEBUG)
        console.log(`[cardsight] -30 Draft Picks penalty: ${c.releaseName}`);
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

  if (process.env.CARDSHOW_DEBUG) {
    console.log('[cardsight] input card:', {
      player:     card.player,
      year:       card.year,
      cardSet:    card.cardSet,
      cardNumber: card.cardNumber,
      grade:      card.grade,
      grader:     card.grader,
      parallel:   card.parallel,
      sport:      card.sport,
    });
    const rn = extractReleaseName(card.cardSet);
    console.log('[cardsight] extractReleaseName result:', rn);

    // Self-test: ensure Topps Chrome never maps to a Panini product
    const selfTests = [
      ['Topps Chrome',        'Topps Chrome'],
      ['Topps Chrome Update', 'Topps Chrome Update'],
      ['Prizm',               'Prizm'],
      ['Panini Prizm',        'Prizm'],
    ];
    for (const [input, expected] of selfTests) {
      const result = extractReleaseName(input);
      if (result !== expected)
        console.error(`[cardsight] extractReleaseName bug: "${input}" → "${result}" (expected "${expected}")`);
    }
  }

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

            // Strip autograph/rookie status — CardSight tracks those at the
          // card level, not the parallel level. Parallels are "Refractor",
          // "Gold Refractor", "SuperFractor" etc.
          const hadRefractor = /refractor/i.test(card.parallel);
          const sellerPStr = card.parallel.toLowerCase()
            .replace(/\/\d+/g, '')
            .replace(/\bautograph\b/g, '')
            .replace(/\bauto\b/g, '')
            .replace(/\brc\b/g, '')
            .replace(/\brookie\b/g, '')
            .replace(/\brefractor\b/g, '')
            .trim();
          const normPStr    = hadRefractor ? sellerPStr + ' refractor' : sellerPStr;
          const sellerWords = normPStr.split(/\s+/).filter(w => w.length > 2);
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
    const sellerParallel    = (card.parallel || '').toLowerCase();
    const sellerRunMatch    = sellerParallel.match(/\/(\d+)/);
    const sellerRun         = sellerRunMatch ? sellerRunMatch[1] : null;
    const hadRefractorSort  = /refractor/i.test(card.parallel || '');
    const normParallelSort  = sellerParallel
      .replace(/\/\d+/g,      '')
      .replace(/\bautograph\b/g, '')
      .replace(/\bauto\b/g,   '')
      .replace(/\brc\b/g,     '')
      .replace(/\brookie\b/g, '')
      .replace(/\brefractor\b/g, '')
      .trim();
    const parallelWords = (hadRefractorSort ? normParallelSort + ' refractor' : normParallelSort)
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Separate completed sales from BIN (fixed-price) listings.
    // Completed sales are the primary comp signal.
    // BIN listings are used as fallback only when no completed sales exist.
    function scoreAndSortRecords(records) {
      if (!Array.isArray(records)) return { rows: [], isBinOnly: false };

      const isCompleted = r => {
        const lt = String(r?.listing_type ?? r?.type ?? '').toLowerCase();
        return !lt || lt === 'sold' || lt === 'completed' || lt === 'auction';
      };
      const isBin = r =>
        String(r?.listing_type ?? r?.type ?? '').toLowerCase() === 'fixed';

      const completedSales = records.filter(isCompleted);
      const binListings    = records.filter(isBin);

      const sourceRecords = completedSales.length ? completedSales : binListings;
      const binOnly       = completedSales.length === 0 && binListings.length > 0;

      const scored = sourceRecords.map(r => {
        const recParallel = (r?.parallel_name || '').toLowerCase();
        let matchScore = 0;
        if (sellerParallel && recParallel) {
          for (const word of parallelWords) {
            if (recParallel.includes(word)) matchScore += 10;
          }
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

      const rows = scored.slice(0, 5).map(r => ({
        price:        Number(r?.price ?? r?.sold_price ?? r?.amount ?? 0),
        date:         r?.date ?? r?.sold_date ?? r?.created_at ?? null,
        source:       r?.source ?? r?.marketplace ?? 'CardSight',
        url:          r?.url ?? r?.listing_url ?? r?.source_url ?? null,
        image:        r?.image_url ?? r?.image ?? r?.card_image ?? null,
        parallelName: r?.parallel_name || null,
        isBin:        isBin(r),
      })).filter(r => r.price > 0);

      return { rows, isBinOnly: binOnly };
    }

    let isBinOnly = false;

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
        const sorted = scoreAndSortRecords(gradeMatch?.records ?? gradeMatch?.sales ?? []);
        recentSales  = sorted.rows;
        isBinOnly    = sorted.isBinOnly;
      }
    }

    // Fall back to raw (ungraded) sales if no graded records found
    if (!recentSales.length) {
      // VERIFY: raw section field name from Swagger (currently 'raw')
      const rawRecords = pricingData?.raw?.records
        ?? pricingData?.raw?.sales
        ?? pricingData?.records
        ?? [];
      const sorted = scoreAndSortRecords(rawRecords);
      recentSales  = sorted.rows;
      isBinOnly    = sorted.isBinOnly;
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
      isBinOnly:   isBinOnly  || false,
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

// Map seller sport to PriceCharting console-name keyword.
function pcSportCategory(sport) {
  const s = (sport || '').toLowerCase();
  if (s === 'baseball')   return 'baseball';
  if (s === 'basketball') return 'basketball';
  if (s === 'football')   return 'football';
  if (s === 'hockey')     return 'hockey';
  if (s === 'soccer')     return 'soccer';
  if (s === 'pokemon')    return 'pokemon';
  return null;
}

// Infer sport from player name — checks full names first for precision,
// then falls back to last-name fragments. Football and basketball checked
// before baseball to avoid ambiguous fragments like 'murray' or 'jackson'.
function inferSportFromPlayer(playerName) {
  if (!playerName) return null;
  const p = playerName.toLowerCase();

  const football = [
    'josh allen','patrick mahomes','lamar jackson','joe burrow',
    'justin herbert','jalen hurts','tom brady','peyton manning',
    'aaron rodgers','matthew stafford','dak prescott','trevor lawrence',
    'cj stroud','c.j. stroud','brock purdy','bryce young','jordan love',
    'anthony richardson',
    'mahomes','burrow','herbert','prescott','stroud','purdy',
  ];
  const basketball = [
    'lebron james','stephen curry','kevin durant','ja morant',
    'victor wembanyama','cooper flagg','anthony edwards','jayson tatum',
    'nikola jokic','giannis antetokounmpo','joel embiid','devin booker',
    'damian lillard','tyrese maxey','jalen brunson',
    'shai gilgeous-alexander','michael jordan',
    'morant','wembanyama','flagg','tatum','jokic','giannis','embiid',
    'booker','lillard','maxey','brunson','gilgeous',
  ];
  const baseball = [
    'mike trout','shohei ohtani','aaron judge','ronald acuna',
    'ronald acuña','fernando tatis','julio rodriguez','juan soto',
    'mookie betts','rafael devers','vladimir guerrero','pete alonso',
    'paul skenes','gunnar henderson','jackson holliday',
    'trout','ohtani','judge','acuna','acuña','tatis','soto','betts',
    'devers','skenes','mantle','mays','jeter','ripken','gehrig',
    'ruth','koufax','clemente','bench','seaver','gwynn',
  ];

  if (football.some(n => p.includes(n)))   return 'Football';
  if (basketball.some(n => p.includes(n))) return 'Basketball';
  if (baseball.some(n => p.includes(n)))   return 'Baseball';
  return null;
}

// Score a PriceCharting result against the seller's card.
// Bracket variants like [Image Variation] are subsets — penalise unless
// the bracket content matches the seller's parallel.
function scorePCResult(product, card) {
  const pName    = (product['product-name'] || '').toLowerCase();
  const pConsole = (product['console-name'] || '').toLowerCase();
  let score = 0;

  if (process.env.CARDSHOW_DEBUG) {
    console.log('[PC score] sport:', card.sport,
      '| player:', card.player,
      '| product:', (product['product-name'] || '').slice(0, 50),
      '| console:', product['console-name']);
  }

  // Bracket variants are subset/parallel cards — penalise unless bracket
  // content matches seller's parallel (e.g. seller has "Gold /10" → [Gold])
  const bracketMatch = (product['product-name'] || '').match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    const bracketContent = bracketMatch[1].toLowerCase();
    const sellerParallel = (card.parallel || '').toLowerCase();
    if (sellerParallel && sellerParallel.includes(bracketContent)) {
      score += 5;   // bracket matches seller parallel — ok
    } else {
      score -= 25;  // bracket doesn't match — strong penalty
    }
  } else {
    score += 15;    // no bracket — base card bonus
  }

  // Card number — exact match bonus; different number tiebreaker penalty
  const num = (card.cardNumber || '').trim();
  if (num) {
    if (pName.includes('#' + num.toLowerCase())) {
      score += 20;  // exact number match
    } else {
      const productNumMatch = pName.match(/#(\w+)/);
      const productNum = productNumMatch?.[1] || '';
      if (productNum && productNum !== num.toLowerCase()) {
        score -= 5;  // product has a different number — tiebreaker penalty
      }
    }
  }

  // Player name — match against pre-# portion only to avoid "Allen" matching "Allen & Ginter"
  const playerPortion = pName.split(/\s*#/)[0].trim();
  const playerParts = (card.player || '').toLowerCase().split(/\s+/);
  const playerLast  = playerParts[playerParts.length - 1] || '';
  const playerFirst = playerParts[0] || '';
  const playerMatch = playerLast.length > 2 && playerFirst.length > 1
    && playerPortion.includes(playerLast)
    && playerPortion.includes(playerFirst);

  if (playerMatch) {
    score += 15;  // both first and last name in player portion
  } else if (playerPortion.length > 0 && playerLast.length > 2) {
    score -= 20;  // wrong player — strong penalty
  }

  // Sport / category match via console-name field.
  // card.sport may be blank — fall back to player name inference.
  let inferredSport = (card.sport || '').toLowerCase();
  if (!inferredSport) {
    const inferred = inferSportFromPlayer(card.player);
    if (inferred) {
      inferredSport = inferred.toLowerCase();
      if (process.env.CARDSHOW_DEBUG)
        console.log('[PC score] sport inferred from player:', inferred, '| player:', card.player);
    }
  }

  const sellerCategory = pcSportCategory(inferredSport);
  if (sellerCategory) {
    if (pConsole.includes(sellerCategory)) {
      score += 20;  // correct sport category
      if (process.env.CARDSHOW_DEBUG) console.log('[PC score] +20 sport match:', sellerCategory, '|', product['console-name']);
    } else if (['baseball', 'basketball', 'football', 'hockey', 'soccer', 'pokemon']
        .some(s => s !== sellerCategory && pConsole.includes(s))) {
      score -= 40;  // wrong sport — eliminate cross-sport false positives
      if (process.env.CARDSHOW_DEBUG) console.log('[PC score] -40 sport mismatch:', sellerCategory, 'vs', product['console-name']);
    }
  } else if (process.env.CARDSHOW_DEBUG) {
    console.log('[PC score] sport check skipped — could not determine seller sport');
  }

  // Year match scoring — penalise by delta to prevent 2025 card winning over 2018
  const sellerYear = parseInt(card.year) || 0;
  if (sellerYear > 0) {
    const yearMatch = pConsole.match(/\b(19|20)\d{2}\b/);
    const productYear = yearMatch ? parseInt(yearMatch[0]) : 0;
    if (productYear > 0) {
      const delta = Math.abs(productYear - sellerYear);
      let yearScore;
      if (delta === 0)      yearScore = 15;
      else if (delta <= 1)  yearScore = -5;
      else if (delta <= 3)  yearScore = -15;
      else                  yearScore = -30;
      score += yearScore;
      if (process.env.CARDSHOW_DEBUG)
        console.log(`[PC score] year ${productYear} vs ${sellerYear}: ${yearScore > 0 ? '+' : ''}${yearScore}`);
    }
  }

  // Subset / variation keywords — penalise regardless of brackets
  const subsetKeywords = [
    'image variation', 'photo variation', 'rookie cup', 'award winner',
    'all star', 'short print', 'super short print', 'variation', 'error',
  ];
  for (const kw of subsetKeywords) {
    if (pName.includes(kw)) { score -= 15; break; }
  }

  return score;
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

    if (process.env.CARDSHOW_DEBUG)
      console.log('[PC] products returned:', products.length);

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

    // Score results — penalise bracket variants that don't match seller's parallel
    const scoredProducts = products
      .map(p => ({ product: p, score: scorePCResult(p, card) }))
      .sort((a, b) => b.score - a.score);

    if (process.env.CARDSHOW_DEBUG) {
      console.log('[PC] top 3 scored results:');
      scoredProducts.slice(0, 3).forEach(s =>
        console.log(`  [${s.score}]`, s.product['product-name'], '|', s.product['console-name']));
    }

    let product = scoredProducts[0].product;
    if (!product?.id) return { stub: true, noData: true };

    if (process.env.CARDSHOW_DEBUG)
      console.log('[PC] best match:', product['product-name'], '|', product['console-name']);

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
    // Build Lucene query for pokemontcg.io v2 API.
    // NOTE: "/" is a reserved Lucene character — never pass "4/102" as number.
    // pokemontcg.io stores only the base number before the slash.
    const queryParts = [`name:"${name}"`];

    if (card.cardNumber) {
      const baseNumber = card.cardNumber.split('/')[0].trim();
      // Only add numeric base numbers — alphanumeric codes don't appear in Pokémon
      if (baseNumber && /^\d+$/.test(baseNumber)) {
        queryParts.push(`number:${baseNumber}`);
      }
    }

    // Set name — strip year prefix and reserved Lucene characters.
    // "&" in "Scarlet & Violet 151" causes pokemontcg.io query timeouts.
    if (card.cardSet) {
      const setName = card.cardSet
        .replace(/^\d{4}[-\s]*/, '')
        .replace(/&/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (setName) queryParts.push(`set.name:"${setName}"`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.POKEMON_TCG_API_KEY) {
      headers['X-Api-Key'] = process.env.POKEMON_TCG_API_KEY;
    } else {
      console.warn('[pokemontcg] POKEMON_TCG_API_KEY not set — unauthenticated (throttled)');
    }

    const q = queryParts.join(' ');
    const pokeUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5&orderBy=-set.releaseDate`;
    if (process.env.CARDSHOW_DEBUG) console.log('[pokemontcg] query:', q);

    let res;
    try {
      res = await fetch(pokeUrl, { headers, signal: AbortSignal.timeout(4000) });
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err;
      console.warn('[pokemontcg] full query timed out — retrying name-only');
      const retryUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${name}"`)}&pageSize=5&orderBy=-set.releaseDate`;
      try {
        res = await fetch(retryUrl, { headers, signal: AbortSignal.timeout(3000) });
      } catch {
        console.warn('[pokemontcg] retry also timed out');
        return { stub: true };
      }
    }

    if (!res.ok) {
      console.warn('[pokemontcg] API failed:', res.status);
      return { stub: true };
    }

    const data  = await res.json();
    const cards = data.data || [];
    if (!cards.length) return { stub: true, noData: true };

    if (process.env.CARDSHOW_DEBUG)
      console.log('[pokemontcg] results:', cards.length, '| first:', cards[0]?.name, cards[0]?.set?.name);

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
        if (process.env.CARDSHOW_DEBUG)
          console.log('[pokemontcg] matched:', item.name, item.set?.name, '| price:', compPrice);
        return {
          stub:        false,
          compPrice,
          lowPrice,
          highPrice,
          recentSales: [],
          source:      'pokemontcg',
          matchedCard: `${item.name} ${item.set?.name || ''}`.trim(),
        };
      }
    }

    return { stub: true, noData: true };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('[pokemontcg] request timed out');
    } else {
      console.warn('[pokemontcg] error:', err.message);
    }
    return { stub: true };
  }
}

// ── TCG API LOOKUP ──

async function lookupTCGApi(card) {
  const apiKey = process.env.TCG_API_KEY;
  if (!apiKey) {
    console.warn('[tcgapi] TCG_API_KEY not set — returning stub');
    return { stub: true };
  }

  if (process.env.CARDSHOW_DEBUG)
    console.log('[tcgapi] key prefix:', apiKey.slice(0, 16) + '...');

  try {
    const query = [card.player, card.year, card.cardSet, card.cardNumber]
      .filter(Boolean)
      .join(' ');
    if (!query) return { stub: true };

    if (process.env.CARDSHOW_DEBUG) console.log('[tcgapi] query:', query);

    const res = await fetch(
      `https://api.tcgapi.dev/v1/cards?q=${encodeURIComponent(query)}&limit=5`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) {
      console.warn(`[tcgapi] API failed: ${res.status}`);
      if (res.status === 401)
        console.warn('[tcgapi] 401 — check TCG_API_KEY in Netlify environment variables');
      return { stub: true };
    }

    const data = await res.json();
    const item = data?.data?.[0] || data?.results?.[0] || data?.cards?.[0];
    if (!item) return { stub: true, noData: true };

    const compPrice = item.market_price || item.mid_price || item.price || null;

    if (process.env.CARDSHOW_DEBUG) {
      console.log('[tcgapi] matched:', item.name || item.id);
      console.log('[tcgapi] price fields:', JSON.stringify({
        price:        item.price,
        market_price: item.market_price,
        low_price:    item.low_price,
        high_price:   item.high_price,
      }));
    }

    if (!compPrice) return { stub: true, noData: true };

    return {
      stub:        false,
      compPrice:   Number(compPrice),
      lowPrice:    Number(item.low_price  || item.lowPrice  || 0) || null,
      highPrice:   Number(item.high_price || item.highPrice || 0) || null,
      recentSales: [],
      source:      'tcgapi',
      matchedCard: item.name || item.card_name || null,
    };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn('[tcgapi] request timed out');
    } else {
      console.warn('[tcgapi] lookup error:', err.message);
    }
    return { stub: true };
  }
}

// Select the correct price tier from Card Hedge's prices array.
// Array entries look like: { grade: "PSA 10", price: "470.0" }
// Tries exact match first, then closest same-grader grade, then Raw.
function extractCardHedgePrice(prices, card) {
  if (!prices || !prices.length) return null;

  const gradeNum = parseFloat(card.grade) || 0;
  const grader   = (card.grader || 'PSA').toUpperCase();

  const targetLabel = gradeNum > 0 ? `${grader} ${gradeNum}` : 'Raw';

  // Exact match
  let entry = prices.find(p =>
    (p.grade || '').toLowerCase() === targetLabel.toLowerCase()
  );

  // Closest grade from same grader
  if (!entry && gradeNum > 0) {
    const graderEntries = prices.filter(p =>
      (p.grade || '').toUpperCase().startsWith(grader)
    );
    if (graderEntries.length) {
      entry = graderEntries.reduce((best, p) => {
        const pG    = parseFloat((p.grade    || '').replace(/[^\d.]/g, ''));
        const bestG = parseFloat((best?.grade || '0').replace(/[^\d.]/g, ''));
        return Math.abs(pG - gradeNum) < Math.abs(bestG - gradeNum) ? p : best;
      });
    }
  }

  // Raw fallback
  if (!entry) entry = prices.find(p => (p.grade || '').toLowerCase() === 'raw');

  if (!entry) return null;
  const price = parseFloat(entry.price);
  return isNaN(price) ? null : price;
}

// ── CARD HEDGE LOOKUP ──
// Primary source for sports cards when CARDHEDGE_ENABLED is true.
// Three-step flow:
//   Step 1: POST /v1/cards/card-match  → card_id (5s timeout)
//           Fallback: POST /v1/cards/90day-prices-by-grade if card-match fails
//   Step 2: POST /v1/cards/card-fmv   → compPrice, confidence_grade, price_explanation
//           D confidence suppressed — falls through to CardSight
//   Step 3: POST /v1/cards/comps      → recent sales (4s timeout, non-fatal)
// Auth: X-API-Key header (NOT Bearer)
// Note: card-search and card-details endpoints return only TOP grade prices —
//       do NOT use for comp pricing; always use card-fmv or comps.

async function lookupCardHedge(card) {
  const apiKey = process.env.CARDHEDGE_API_KEY;
  if (!apiKey) return { stub: true };

  const BASE = 'https://api.cardhedger.com';
  const headers = {
    'X-API-Key':    apiKey,
    'Content-Type': 'application/json',
  };

  // Build description string for card-match — single free-text query expected by API.
  // When cardSet is empty (e.g. seller didn't fill in set field), fall back to
  // cardTitle which typically contains year + set + player already.
  const description = card.cardSet
    ? [
        card.year,
        card.cardSet,
        card.player,
        card.parallel,
        card.grader && card.grade ? `${card.grader} ${card.grade}` : '',
      ].filter(Boolean).join(' ').trim()
    : [
        card.cardTitle || [card.year, card.player].filter(Boolean).join(' '),
        card.parallel,
        card.grader && card.grade ? `${card.grader} ${card.grade}` : '',
      ].filter(Boolean).join(' ').trim();

  if (process.env.CARDSHOW_DEBUG)
    console.log('[cardhedge] card-match description:', description);

  try {
    // ── Step 1: card-match ───────────────────────────────────────────────────
    let cardId      = null;
    let matchedCard = null;

    const matchRes = await fetch(`${BASE}/v1/cards/card-match`, {
      method: 'POST', headers, body: JSON.stringify({ query: description }),
      signal: AbortSignal.timeout(4000),
    });

    if (matchRes.ok) {
      const matchData = await matchRes.json();
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardhedge] card-match raw:', JSON.stringify(matchData, null, 2));

      // Response is nested: { match: { card_id, confidence, player, prices: [...] } }
      const match = matchData?.match || matchData;
      cardId      = match?.card_id ?? match?.id ?? match?.cardId ?? null;
      matchedCard = match?.player ?? match?.description ?? match?.name ?? null;

      if (process.env.CARDSHOW_DEBUG) {
        console.log('[cardhedge] card_id:', cardId);
        console.log('[cardhedge] matched:', matchedCard);
        console.log('[cardhedge] match confidence:', match?.confidence);
      }

      // prices array is included in the match response — extract correct grade tier now
      const matchPrices = match?.prices || [];
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardhedge] match prices:', JSON.stringify(matchPrices));

      const matchPrice = extractCardHedgePrice(matchPrices, card);
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardhedge] extracted price:', matchPrice, '| grade:', card.grade, '| grader:', card.grader);

      if (matchPrice && matchPrice > 0) {
        // Price found in match response — fetch comps for recent sales, then return
        const rawConfidence = match?.confidence ?? null;
        const confidenceGrade = rawConfidence !== null
          ? (rawConfidence >= 0.9 ? 'A' : rawConfidence >= 0.7 ? 'B' : rawConfidence >= 0.5 ? 'C' : 'D')
          : null;

        // Suppress D-confidence — fall through to CardSight
        if (confidenceGrade === 'D') {
          console.log('[cardhedge] suppressed: D confidence (', rawConfidence, ')');
          return { stub: true };
        }

        let recentSales = [];
        if (cardId) {
          try {
            const compsRes = await fetch(`${BASE}/v1/cards/comps`, {
              method: 'POST', headers,
              body:   JSON.stringify({ card_id: cardId, query: description }),
              signal: AbortSignal.timeout(3000),
            });
            if (compsRes.ok) {
              const compsJson = await compsRes.json();
              if (process.env.CARDSHOW_DEBUG)
                console.log('[cardhedge] comps raw:', JSON.stringify(compsJson));
              const records = compsJson?.records ?? compsJson?.comps ?? compsJson?.data ?? compsJson?.results ?? [];
              if (Array.isArray(records)) {
                recentSales = records.slice(0, 5).map(r => ({
                  price:  Number(r?.price ?? r?.sale_price ?? r?.amount ?? 0),
                  date:   r?.date ?? r?.sale_date ?? r?.sold_date ?? null,
                  source: r?.source ?? r?.marketplace ?? 'Card Hedge',
                  url:    r?.url ?? r?.listing_url ?? null,
                  image:  r?.image_url ?? r?.image ?? null,
                  isBin:  false,
                })).filter(r => r.price > 0);
              }
            }
          } catch (err) {
            console.warn('[cardhedge] comps error (non-fatal):', err.message);
          }
        }

        return {
          stub:             false,
          compPrice:        matchPrice,
          lowPrice:         null,
          highPrice:        null,
          recentSales:      recentSales.slice(0, 3),
          source:           'cardhedge',
          matchedCard,
          confidence:       confidenceGrade,
          priceExplanation: match?.reasoning ?? null,
        };
      }
    } else {
      const errBody = await matchRes.text().catch(() => '');
      console.warn('[cardhedge] card-match failed:', matchRes.status, errBody);
      if (matchRes.status === 401 || matchRes.status === 429) return { stub: true };
    }

    // ── Step 1b: 90day-prices-by-grade fallback ──────────────────────────────
    // Reached when card-match failed OR match response had no usable price
    if (!cardId) {
      if (process.env.CARDSHOW_DEBUG)
        console.log('[cardhedge] trying 90day-prices-by-grade fallback');
      try {
        const fbBody = {
          query:  description,
          grade:  parseFloat(card.grade) || undefined,
          grader: card.grader            || undefined,
        };
        Object.keys(fbBody).forEach(k => fbBody[k] === undefined && delete fbBody[k]);

        const fbRes = await fetch(`${BASE}/v1/cards/90day-prices-by-grade`, {
          method: 'POST', headers, body: JSON.stringify(fbBody),
          signal: AbortSignal.timeout(4000),
        });
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          if (process.env.CARDSHOW_DEBUG)
            console.log('[cardhedge] 90day raw:', JSON.stringify(fbData, null, 2));
          const priceRaw  = fbData?.price ?? fbData?.fmv ?? fbData?.fair_market_value ?? fbData?.data?.price ?? null;
          const compPrice = priceRaw ? Number(priceRaw) : null;
          if (compPrice && compPrice > 0) {
            return {
              stub:        false, compPrice,
              lowPrice:    Number(fbData?.low_price ?? fbData?.low ?? 0) || null,
              highPrice:   Number(fbData?.high_price ?? fbData?.high ?? 0) || null,
              recentSales: [], source: 'cardhedge',
              matchedCard: card.player || null, confidence: null,
            };
          }
        }
      } catch (err) {
        console.warn('[cardhedge] 90day-prices-by-grade error:', err.message);
      }
      return { stub: true };
    }

    // ── Step 2: card-fmv — only reached when card-match succeeded but prices[] was empty ──
    const fmvRes = await fetch(`${BASE}/v1/cards/card-fmv`, {
      method: 'POST', headers, body: JSON.stringify({ card_id: cardId, query: description }),
      signal: AbortSignal.timeout(4000),
    });

    if (!fmvRes.ok) {
      console.warn('[cardhedge] card-fmv failed:', fmvRes.status);
      return { stub: true };
    }

    const fmvData = await fmvRes.json();
    if (process.env.CARDSHOW_DEBUG)
      console.log('[cardhedge] card-fmv raw:', JSON.stringify(fmvData));

    const compPrice        = Number(fmvData?.fmv ?? fmvData?.price ?? fmvData?.fair_market_value ?? fmvData?.data?.fmv ?? 0) || null;
    const rawConf          = fmvData?.confidence ?? fmvData?.confidence_grade ?? fmvData?.data?.confidence_grade ?? null;
    const confidence       = typeof rawConf === 'number'
      ? (rawConf >= 0.9 ? 'A' : rawConf >= 0.7 ? 'B' : rawConf >= 0.5 ? 'C' : 'D')
      : (rawConf ? String(rawConf).toUpperCase() : null);
    const priceExplanation = fmvData?.price_explanation ?? fmvData?.reasoning ?? fmvData?.explanation ?? null;

    if (!compPrice || confidence === 'D') {
      console.log('[cardhedge] suppressed:', !compPrice ? 'no price' : 'D confidence');
      return { stub: true };
    }

    // ── Step 3: comps (non-fatal) ─────────────────────────────────────────────
    let recentSales = [];
    try {
      const compsRes = await fetch(`${BASE}/v1/cards/comps`, {
        method: 'POST', headers, body: JSON.stringify({ card_id: cardId, query: description }),
        signal: AbortSignal.timeout(3000),
      });
      if (compsRes.ok) {
        const compsData = await compsRes.json();
        if (process.env.CARDSHOW_DEBUG)
          console.log('[cardhedge] comps raw:', JSON.stringify(compsData));
        const sales = compsData?.comps ?? compsData?.sales ?? compsData?.data ?? compsData?.results ?? [];
        if (Array.isArray(sales)) {
          recentSales = sales.slice(0, 5).map(s => ({
            price:  Number(s?.price ?? s?.sale_price ?? s?.amount ?? 0),
            date:   s?.date ?? s?.sale_date ?? s?.sold_date ?? null,
            source: s?.source ?? s?.marketplace ?? 'Card Hedge',
            url:    s?.url ?? s?.listing_url ?? null,
            image:  s?.image_url ?? s?.image ?? null,
            isBin:  false,
          })).filter(s => s.price > 0);
        }
      }
    } catch (err) {
      console.warn('[cardhedge] comps error (non-fatal):', err.message);
    }

    const allPrices = recentSales.map(s => s.price);
    return {
      stub:             false,
      compPrice,
      lowPrice:         allPrices.length ? Math.min(...allPrices) : null,
      highPrice:        allPrices.length ? Math.max(...allPrices) : null,
      recentSales:      recentSales.slice(0, 3),
      source:           'cardhedge',
      matchedCard:      matchedCard || card.player || null,
      confidence,
      priceExplanation: priceExplanation || null,
    };

  } catch (err) {
    if (err.name === 'TimeoutError') console.warn('[cardhedge] timeout');
    else console.warn('[cardhedge] error:', err.message);
    return { stub: true };
  }
}

// ── ROUTER ──
// Pokemon     → pokemontcg.io, fallback to TCG API
// Other TCG   → TCG API
// Sports      → Card Hedge (primary, if enabled) → CardSight AI → PriceCharting

async function lookupComp(card) {
  const cached = await checkPriceCache(card);
  if (cached) return cached;

  // Resolve sport — use explicit field or infer from player name
  const resolvedSport = card.sport || inferSportFromPlayer(card.player) || '';
  if (process.env.CARDSHOW_DEBUG && resolvedSport !== (card.sport || ''))
    console.log('[lookupComp] sport resolved via inference:', resolvedSport, '(was:', card.sport || 'empty', ')');

  const isPokemon = resolvedSport === 'Pokemon';
  const isTCG     = TCG_SPORTS.includes(resolvedSport);

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
    // Sports: Card Hedge (primary) → CardSight AI (secondary) → PriceCharting (fallback)
    if (CARDHEDGE_ENABLED) {
      result = await lookupCardHedge(card);
      if (result.stub) console.log('[cardhedge] miss — falling back to CardSight');
    }

    if (!result || result.stub || !result.compPrice) {
      const cachedIds = await getCachedIds(card);
      result = await lookupCardSight(card, cachedIds);
      if (!result || result.stub || !result.compPrice) {
        console.log('CardSight miss — falling back to PriceCharting');
        result = await lookupPriceCharting(card);
      }
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
  if (process.env.CARDSHOW_DEBUG) {
    console.log('[comp-lookup] env check:', {
      CARDHEDGE_API_KEY:    !!process.env.CARDHEDGE_API_KEY,
      CARDHEDGE_ENABLED:    CARDHEDGE_ENABLED,
      CARDSIGHT_API_KEY:    !!process.env.CARDSIGHT_API_KEY,
      PRICECHARTING_TOKEN:  !!process.env.PRICECHARTING_TOKEN,
      TCG_API_KEY:          !!process.env.TCG_API_KEY,
      POKEMON_TCG_API_KEY:  !!process.env.POKEMON_TCG_API_KEY,
      SUPABASE_URL:         !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    });
  }

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
