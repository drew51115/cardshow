// netlify/functions/cardsight-identify.js
// POST { image_base64, media_type } → CardSight AI catalog identification,
// normalized for Show Mode. See CLAUDE.md "Show Mode v2".
//
// Runs alongside scan-card.js (Claude vision) — the phone calls both in
// parallel and merges the results, so each stays inside Netlify's ~10s
// function limit and either can fail without blocking the other.
// Claude reads the slab label (grader, grade, cert #) reliably; CardSight
// adds a catalog card ID (pricing, stock images, duplicate checks) and
// catalog-accurate set/number/parallel names.
//
// Endpoint and response shape confirmed from CardSight's own TypeScript SDK
// (cardsightai@4.2.0): POST https://api.cardsight.ai/v1/identify/card,
// multipart field "image", header X-API-Key. Response:
//   { success, requestId, detections: [{ confidence: 'High'|'Medium'|'Low',
//     card: { id, year, manufacturer, releaseName, setName, name, number,
//             numberedTo, attributes, parallelSuggestions, suggestions },
//     grading: { confidence, company: { name }, grade: { value }, certNumber } }],
//     detectedCount, identifiedCount }
// Shares CARDSIGHT_API_KEY (and its monthly quota) with comp-lookup.js.

const CARDSIGHT_URL = 'https://api.cardsight.ai/v1/identify/card';
const TIMEOUT_MS = 8000;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function tier(c) {
  const v = String(c || '').toLowerCase();
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

// "Topps Chrome" + "Base Set" → "Topps Chrome"; + "Refractors" → "Topps Chrome Refractors"
function cardSetName(card) {
  const release = (card.releaseName || '').trim();
  const set = (card.setName || '').trim();
  if (!set || /^base( set)?$/i.test(set)) return release;
  if (!release) return set;
  return set.toLowerCase().includes(release.toLowerCase()) ? set : `${release} ${set}`;
}

function normalizeCard(card) {
  if (!card || typeof card !== 'object') return null;
  const parallel = Array.isArray(card.parallelSuggestions) && card.parallelSuggestions[0]
    ? (card.parallelSuggestions[0].name || card.parallelSuggestions[0].parallelName || '')
    : '';
  return {
    catalogCardId: card.id || null,
    player: card.name || '',
    year: card.year || '',
    cardSet: cardSetName(card),
    number: card.number || '',
    parallel,
    numberedTo: card.numberedTo || null,
    attributes: Array.isArray(card.attributes) ? card.attributes : [],
    manufacturer: card.manufacturer || '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'method_not_allowed' });

  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) return json(200, { success: false, error: 'missing_key' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { success: false, error: 'parse_error' }); }
  const { image_base64, media_type } = body;
  if (!image_base64) return json(400, { success: false, error: 'image_base64 required' });

  const mediaType = /^image\/(jpeg|png|webp)$/.test(media_type || '') ? media_type : 'image/jpeg';
  const form = new FormData();
  form.append('image', new Blob([Buffer.from(image_base64, 'base64')], { type: mediaType }), 'card.jpg');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CARDSIGHT_URL, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[cardsight-identify] HTTP', res.status, text.slice(0, 300));
      return json(200, { success: false, error: `cardsight_http_${res.status}` });
    }
    const data = await res.json();
    const det = Array.isArray(data.detections) ? data.detections[0] : null;
    if (!det) {
      return json(200, { success: false, error: 'no_card', detectedCount: data.detectedCount ?? 0 });
    }
    const card = normalizeCard(det.card) || {};
    const grading = det.grading || null;
    const suggestions = Array.isArray(det.card?.suggestions)
      ? det.card.suggestions.slice(0, 4).map(normalizeCard).filter(Boolean)
      : [];
    return json(200, {
      success: true,
      identified: !!(card.player || card.cardSet),
      detection: {
        ...card,
        confidence: tier(det.confidence),
        grader: grading?.company?.name || '',
        grade: grading?.grade?.value || '',
        certNumber: grading?.certNumber || '',
        gradingConfidence: grading ? tier(grading.confidence) : null,
        suggestions,
      },
      detectedCount: data.detectedCount ?? null,
      requestId: data.requestId || null,
    });
  } catch (err) {
    if (err.name === 'AbortError') return json(200, { success: false, error: 'timeout' });
    console.warn('[cardsight-identify]', err.message);
    return json(200, { success: false, error: 'network_error' });
  } finally {
    clearTimeout(timer);
  }
};
