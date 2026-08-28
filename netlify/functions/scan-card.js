// Netlify Function: scan-card
// POST { image_base64: "<base64>", media_type: "image/jpeg" }
// Returns structured card data + per-field confidence for the Photo Scan &
// Card Fingerprinting flow — Scan-to-Sell POS review and the Manual Sale
// modal's photo capture (see CLAUDE.md "Photo Scan & Card Fingerprinting").
//
// Deliberately a separate function from vision-scan.js (the Add Card modal
// cascade) rather than a shared call: this prompt draws an explicit
// distinction between a graded slab's cert number and a raw/graded card's
// own printed serial number ("45/99") — vision-scan.js's prompt doesn't,
// and this feature's duplicate-detection fingerprint depends on getting
// that distinction right.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-sonnet-4-6';
const MAX_TOKENS         = 1024;
const TIMEOUT_MS         = 10000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[scan-card] WARNING: ANTHROPIC_API_KEY is not set — card scan will fail at runtime');
}

// card_number is a bonus field beyond the original spec's shape — the
// Scan-to-Sell POS review form has a Card # field that every other
// identification path in this app fills, and dropping it here would be
// a real regression for that flow. It plays no part in computeCardFingerprint().
const SYSTEM_PROMPT = `You are extracting structured data from a photo of a single trading card,
which may be raw or inside a graded slab (PSA, BGS, SGC, CGC, etc.). Return ONLY a JSON object,
no markdown fences, no preamble, matching this exact shape:

{
  "player_name": string | null,
  "year": string | null,
  "set_name": string | null,
  "subset": string | null,
  "card_number": string | null,
  "parallel_name": string | null,
  "parallel_serial": string | null,
  "autograph": boolean,
  "grading_company": "PSA" | "BGS" | "SGC" | "CGC" | null,
  "grade": string | null,
  "cert_number": string | null,
  "confidence": {
    "player_name": number,
    "year": number,
    "set_name": number,
    "grade": number,
    "cert_number": number
  }
}

Rules:
- cert_number is the small number printed on the grading label (top or bottom), NOT the
  serial number printed on the card itself. These are frequently confused — the cert
  number is usually 8-10 digits with no slash; the serial number looks like "45/99".
- card_number is the card's own number within its set, printed on the card front or back
  (e.g. "150", "BCP-196") — distinct from both cert_number and parallel_serial.
- If the card is raw (ungraded), grading_company, grade, and cert_number are all null.
- confidence values are 0.0-1.0, reflecting how legible/certain each field is from the image.
- If a field can't be determined, use null rather than guessing.
- Return valid JSON only.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'method_not_allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      body: JSON.stringify({ success: false, error: 'api_error', message: 'ANTHROPIC_API_KEY not configured' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'Invalid JSON body' }) };
  }

  const { image_base64, media_type } = body;
  if (!image_base64) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'image_base64 required' }) };
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
            { type: 'text',  text: 'Extract the card data as specified.' },
          ],
        }],
      }),
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[scan-card] Anthropic API error', res.status, detail);
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'api_error', message: `Anthropic API error ${res.status}` }) };
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text response from model');

    const cleaned = textBlock.text.replace(/```json|```/gi, '').trim();

    let card;
    try {
      card = JSON.parse(cleaned);
    } catch {
      console.error('[scan-card] JSON parse failed. Raw:', textBlock.text.slice(0, 500));
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'parse_error', message: 'Could not parse scan response', rawResponse: textBlock.text }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, card }) };

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'timeout', message: 'Card scan timed out after 10 seconds' }) };
    }
    console.error('[scan-card] unexpected error:', err.message);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'api_error', message: err.message }) };
  }
};
