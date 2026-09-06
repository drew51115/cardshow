// Netlify Function: tcapi
// GET ?path=/v1/players?full_name=paul+skenes
// Generic proxy for Trading Card API — keeps TRADING_CARD_API_KEY server-side.
// The Add Card modal's player/set/card/parallel picker (app.html, tcapiGet())
// is the only current caller. Not related to netlify/functions/trading-card-lookup.js,
// which is the older free-text search-by-name path used by the (now removed)
// #ac_search box — that function has its own key handling and cache table.

const TCG_API_ORIGIN = 'https://api.tradingcardapi.com';
// filter[player_id] on /v1/cards is a real join (direct + via player-team) across the
// card catalog and can run noticeably slower than a simple attribute lookup — the
// catalog itself dropped from ~1.77M to ~326K cards in the API's own v0.10.34 (server
// now filters out cards on unpublished sets by default; this app never called the
// unfiltered endpoint either way, so no client-side change was needed for that) —
// give it real headroom, but stay under Netlify's ~10s synchronous function ceiling
// (matches vision-scan.js's 10s convention elsewhere in this repo) so our own abort
// fires with a clean response instead of the platform hard-killing the function first.
const TIMEOUT_MS = 9000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.TRADING_CARD_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Trading Card API key not configured' }),
    };
  }

  const targetPath = event.queryStringParameters?.path;
  if (!targetPath || !targetPath.startsWith('/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing or invalid path parameter — must start with /' }),
    };
  }

  const url = `${TCG_API_ORIGIN}${targetPath}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
    });

    const data = await response.json().catch(() => ({}));

    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, body: JSON.stringify({ error: 'Trading Card API timed out' }) };
    }
    return { statusCode: 502, body: JSON.stringify({ error: `Proxy error: ${err.message}` }) };
  } finally {
    clearTimeout(timeoutId);
  }
};
