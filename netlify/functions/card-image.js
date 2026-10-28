// netlify/functions/card-image.js
// GET ?id=<CardSight catalog card id> → the card's stock image (JPEG/PNG).
// Show Mode falls back to this when a card has no seller photo. See CLAUDE.md
// "Show Mode v2" → Phase 4.
//
// CardSight endpoint, from its TypeScript SDK (cardsightai@4.2.0):
//   GET https://api.cardsight.ai/v1/images/cards/{id}?format=raw
//   header X-API-Key; 200 = image bytes, 404 = no image for that card.
// Shares CARDSIGHT_API_KEY with comp-lookup.js and cardsight-identify.js.
// Netlify's CDN caches each image for 30 days (a missing image for 1 day), so
// a card's image is fetched from CardSight about once a month however many
// times it's shown.

const TIMEOUT_MS = 8000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(statusCode, text, cacheSeconds) {
  const headers = { 'Content-Type': 'text/plain' };
  if (cacheSeconds) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
    headers['Netlify-CDN-Cache-Control'] = `public, max-age=${cacheSeconds}, durable`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return { statusCode, headers, body: text };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return plain(405, 'Method not allowed');
  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!ID_RE.test(id)) return plain(400, 'Bad card id');
  const key = process.env.CARDSIGHT_API_KEY;
  if (!key) return plain(503, 'Card images are not set up');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.cardsight.ai/v1/images/cards/${encodeURIComponent(id)}?format=raw`, {
      headers: { 'X-API-Key': key },
      signal: controller.signal,
    });
    if (res.status === 404) return plain(404, 'No image for this card', 86400);
    if (!res.ok) {
      console.warn('[card-image] CardSight', res.status, id);
      return plain(502, 'Image lookup failed');
    }
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(type)) return plain(502, 'Unexpected response');
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, max-age=2592000, durable',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.warn('[card-image]', e.name === 'AbortError' ? 'timeout' : e.message, id);
    return plain(504, 'Image lookup timed out');
  } finally {
    clearTimeout(timer);
  }
};
