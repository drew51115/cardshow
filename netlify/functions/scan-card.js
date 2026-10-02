// Netlify Function: scan-card
// POST { image_base64: "<base64>", media_type: "image/jpeg", label_image_base64?: "<base64>" }
// Returns { success, card, flags } — structured card data + per-field 0-1
// confidence for Scan-to-Sell POS review, the Manual Sale modal, and the
// bulk-scan slab-label pass (see CLAUDE.md "Scan Accuracy").
//
// Thin adapter over _shared/scan-core.js (shared with vision-scan.js). Keeps
// the original snake_case response shape; adds serial_number, print_run and
// flags. parallel_serial is still filled ("45/99") for older callers.

const { scanCard } = require('./_shared/scan-core');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[scan-card] WARNING: ANTHROPIC_API_KEY is not set — card scan will fail at runtime');
}

function toLegacyShape(c, flags) {
  const serial = c.serial_number || null;
  const run    = c.print_run || null;
  return {
    player_name:     c.player_name ?? null,
    card_title:      c.card_title ?? null,
    year:            c.year ?? null,
    set_name:        c.set_name ?? null,
    subset:          null,
    card_number:     c.card_number ?? null,
    parallel_name:   c.parallel_name ?? null,
    parallel_serial: serial && run ? `${serial}/${run}` : (serial || (run ? `/${run}` : null)),
    serial_number:   serial,
    print_run:       run,
    autograph:       !!c.autograph,
    grading_company: c.grading_company ?? null,
    grade:           c.grade ?? null,
    grade_numeric:   c.grade_numeric ?? null,
    cert_number:     c.cert_number ?? null,
    label_text:      c.label_text ?? null,
    item_type:       c.item_type || 'card',
    category:        c.category ?? null,
    subcategory:     c.subcategory ?? null,
    confidence:      c.confidence || {},
    flags,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'method_not_allowed' }) };
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

  const { image_base64, media_type, label_image_base64 } = body;
  if (!image_base64) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'image_base64 required' }) };
  }

  const result = await scanCard({
    imageBase64:      image_base64,
    mediaType:        media_type || 'image/jpeg',
    labelImageBase64: label_image_base64 || null,
  });

  if (!result.success) return { statusCode: 200, body: JSON.stringify(result) };

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, card: toLegacyShape(result.card, result.flags), flags: result.flags }),
  };
};
