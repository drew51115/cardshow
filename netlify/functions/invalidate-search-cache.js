// invalidate-search-cache.js
// POST { query: string } — deletes matching rows from card_search_cache.
// Protected by x-invalidate-secret header vs CACHE_INVALIDATE_SECRET env var.
// Returns { deleted: N } on success.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const secret = process.env.CACHE_INVALIDATE_SECRET;
  if (!secret || event.headers['x-invalidate-secret'] !== secret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 503, body: 'Supabase not configured' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { query } = body;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { statusCode: 400, body: 'query string required' };
  }

  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data, error } = await db
      .from('card_search_cache')
      .delete()
      .ilike('query_key', `%${normalized}%`)
      .select('query_key');

    if (error) throw error;

    const deleted = data?.length ?? 0;
    console.log(`[invalidate-search-cache] deleted ${deleted} rows matching "${normalized}"`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleted }),
    };
  } catch (err) {
    console.error('[invalidate-search-cache] error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
