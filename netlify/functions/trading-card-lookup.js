// Netlify Function: trading-card-lookup
// POST { query: string, sport: string|null }
// Returns normalized card results from Trading Card API (tradingcardapi.com).
//
// Results are cached in the card_search_cache Supabase table for 7 days.
// Cache key: "tradingcardapi:{normalised_query}" (lowercased, collapsed whitespace).
// Cache writes are non-blocking — a write failure never breaks the response.
//
// When TRADING_CARD_API_KEY is not set, returns { stub: true, results: [] }
// and the client falls back to the local CARD_DB array — all Sprint 3 UI
// still works without the key.
//
// To activate: add TRADING_CARD_API_KEY in Netlify dashboard →
//   Site settings → Environment variables

const { createClient } = require('@supabase/supabase-js');

const API_BASE    = 'https://api.tradingcardapi.com/v1/cards';
const TIMEOUT_MS  = 5000;
const CACHE_TTL_DAYS = 7;

// ── CACHE HELPERS ──

function buildQueryKey(rawQuery, source = 'tradingcardapi') {
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

// ── HANDLER ──

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.TRADING_CARD_API_KEY;
  if (!apiKey) {
    console.warn('[trading-card-lookup] TRADING_CARD_API_KEY not set — returning stub. Add key to Netlify environment variables to activate.');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: true, results: [] }),
    };
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

  const queryKey = buildQueryKey(query.trim(), 'tradingcardapi');

  // Cache read
  const cached = await readSearchCache(queryKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: false, results: cached.results, fromCache: true, source: cached.source }),
    };
  }

  const params = new URLSearchParams({
    'filter[name]':  query.trim(),
    'page[limit]':   '8',
  });
  if (sport) params.set('filter[sport]', sport);

  const url = `${API_BASE}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/vnd.api+json',
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[trading-card-lookup] API error', res.status, detail);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stub: false, results: [], error: `API error ${res.status}` }),
      };
    }

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];

    const results = items.map(r => ({
      id:         r.id,
      player:     r.attributes?.name         || '',
      year:       r.attributes?.year         ? String(r.attributes.year) : '',
      cardSet:    r.attributes?.set_name     || '',
      cardNumber: r.attributes?.card_number  || null,
      sport:      r.attributes?.sport        || null,
      parallel:   r.attributes?.parallel     || null,
      imageUrl:   r.attributes?.image_url    || null,
    }));

    // Non-blocking cache write
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
    console.error('[trading-card-lookup] fetch error:', err.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stub: false, results: [], error: err.message }),
    };
  }
};
