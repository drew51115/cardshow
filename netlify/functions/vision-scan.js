// Netlify Function: vision-scan
// POST { image: "<base64>", mediaType: "image/jpeg", labelImage?: "<base64>" }
// Returns { success, card, isTCG, promptVariant, flags } — the Add Card cert
// scanner's legacy camelCase shape with high/medium/low confidence strings.
//
// Thin adapter over _shared/scan-core.js (shared with scan-card.js). One
// model call for every card type — the old sports-then-TCG second call is
// gone. labelImage is an optional full-resolution crop of the top of the
// card (where a slab label sits) captured by scanTakePhoto().

const { scanCard } = require('./_shared/scan-core');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[vision-scan] WARNING: ANTHROPIC_API_KEY is not set — vision scan will fail at runtime');
}

function level(n) {
  if (typeof n !== 'number') return 'low';
  if (n >= 0.85) return 'high';
  if (n >= 0.6)  return 'medium';
  return 'low';
}

function toLegacyShape(c) {
  const conf  = c.confidence || {};
  const isTCG = c.category === 'TCG';
  const parallel = [c.parallel_name, c.autograph && !/\bauto/i.test(c.parallel_name || '') ? 'Auto' : null]
    .filter(Boolean).join(' ') || null;
  return {
    player:       c.player_name ?? null,
    cardTitle:    c.card_title ?? null,
    year:         c.year ?? null,
    cardSet:      c.set_name ?? null,
    cardNumber:   c.card_number ?? null,
    parallel,
    serialNumber: c.serial_number ?? null,
    printRun:     c.print_run ?? null,
    autograph:    !!c.autograph,
    grader:       c.grading_company ?? null,
    grade:        c.grade_numeric ?? c.grade ?? null,
    gradeLabel:   c.grade ?? null,
    condition:    null,
    sport:        isTCG ? 'TCG' : (c.subcategory || (c.category === 'Sports' ? 'Other' : null)),
    category:     c.category ?? null,
    subcategory:  c.subcategory ?? null,
    certNumber:   c.cert_number ?? null,
    labelText:    c.label_text ?? null,
    itemType:     c.item_type || 'card',
    productType:  null,
    confidence: {
      player:     level(conf.player_name),
      year:       level(conf.year),
      cardSet:    level(conf.set_name),
      cardNumber: level(conf.card_number),
      parallel:   level(conf.parallel_name),
      grade:      level(conf.grade),
      certNumber: level(conf.cert_number),
    },
    confidenceScores: conf,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 503, body: JSON.stringify({ success: false, error: 'api_error', message: 'ANTHROPIC_API_KEY not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'Invalid JSON body' }) };
  }

  const { image, mediaType = 'image/jpeg', labelImage } = body;
  if (!image) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'image field required' }) };
  }

  const result = await scanCard({ imageBase64: image, mediaType, labelImageBase64: labelImage || null });
  if (!result.success) return { statusCode: 200, body: JSON.stringify(result) };

  const card = toLegacyShape(result.card);

  // All-low guard — cert excluded, since a raw card legitimately has no cert.
  const { certNumber, ...rest } = card.confidence;
  if (Object.values(rest).every(v => v === 'low')) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: false,
        error: 'low_confidence',
        message: 'Could not identify card with confidence — try better lighting',
      }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      card,
      flags: result.flags,
      isTCG: card.category === 'TCG',
      promptVariant: 'unified',
    }),
  };
};
