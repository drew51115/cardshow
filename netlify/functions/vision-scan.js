// Netlify Function: vision-scan
// POST { image: "<base64>", mediaType: "image/jpeg" }
// Returns normalized card object with per-field confidence ratings.
//
// Uses Claude claude-sonnet-4-6 vision API to identify cards in photos.
// Sprint 2 of the CardShow cert scanner cascade:
//   barcode (Sprint 1) → vision (Sprint 2) → TCDB text search (Sprint 3 stub)

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-6';
const MAX_TOKENS        = 1024;
const TIMEOUT_MS        = 10000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[vision-scan] WARNING: ANTHROPIC_API_KEY is not set — vision scan will fail at runtime');
}

const PROMPT_SPORTS = `Analyze this trading card image. Return ONLY a valid JSON object with no markdown, no explanation, no code fences. Use exactly these field names:
{
  "player":      "player name or character name",
  "cardTitle":   "full card title if different from player, else null",
  "year":        1999,
  "cardSet":     "official set/expansion name",
  "cardNumber":  "card number exactly as printed — e.g. BCP-196 or BDA-27 or 150 or null",
  "parallel":    "describe ALL variants visible: Auto, Autograph, Refractor, Holo, Prizm, Gold, Silver, Orange, Blue, Red, Superfractor, etc. Combine if multiple: 'Gold Refractor Auto'. Return null only if base card with no variant.",
  "grader":      "PSA or BGS or CGC or SGC or null if raw",
  "grade":       10,
  "condition":   "Near Mint or Lightly Played or Moderately Played or null",
  "sport":       "Baseball or Basketball or Football or Hockey or Soccer or Pokemon or TCG or Other",
  "certNumber":  "cert/serial number if visible on label, else null",
  "itemType":    "card or sealed or lot",
  "productType": "Booster Box or Booster Pack or ETB or null",
  "confidence": {
    "player":     "high or medium or low",
    "year":       "high or medium or low",
    "cardSet":    "high or medium or low",
    "cardNumber": "high or medium or low",
    "parallel":   "high or medium or low",
    "grade":      "high or medium or low"
  }
}
Rules:
- AUTOGRAPHS: If the card has a signature, sticker auto, or 'AUTO' stamp anywhere on it, ALWAYS include 'Auto' in the parallel field. This is critical — never omit Auto for signed cards.
- CARD NUMBER: Look at the bottom of the card. Bowman Chrome prospects use formats like BCP-196, BDA-27, BCP196. Topps/Prizm use plain numbers. Return exactly what is printed.
- PARALLELS: Colored borders (orange, blue, gold, red), foil patterns (refractor, prizm, holo), and print runs (/50, /99, /10) are all parallel indicators — include them all.
- If a field is not clearly visible, return null — never guess
- For graded slabs, read the label carefully for player, year, set, grade
- For raw cards, read the card front for player name, year, set name, card number
- Confidence is high when text is clearly readable, medium when partially visible or inferred, low when uncertain
- Be precise about set names — distinguish base sets from parallels
- If you see a PSA/BGS/CGC/SGC label, always return the grader field
- year must be an integer or null, grade must be a number or null`;

const PROMPT_TCG = `Analyze this Pokemon or TCG card image. Return ONLY a valid JSON object with no markdown, no explanation, no code fences:
{
  "player":       "Pokemon or character name (e.g. Charizard, Pikachu)",
  "cardTitle":    "full card name including type (e.g. Charizard VMAX, Umbreon GX, Pikachu ex)",
  "year":         1999,
  "cardSet":      "official expansion set name (e.g. Base Set, Scarlet & Violet, Temporal Forces, Paldea Evolved)",
  "cardNumber":   "card number from bottom (e.g. 4/102, 025/198)",
  "parallel":     "Holo Rare or Reverse Holo or Full Art or Alt Art or Special Illustration Rare or Rainbow Rare or Secret Rare or Common or Uncommon or null",
  "grader":       "PSA or BGS or CGC or SGC or null if raw",
  "grade":        10,
  "condition":    "Near Mint or Lightly Played or Moderately Played or null",
  "sport":        "Pokemon",
  "certNumber":   "cert number if graded slab visible, else null",
  "itemType":     "card",
  "hp":           320,
  "rarity":       "Special Illustration Rare or Illustration Rare or Ultra Rare or Holo Rare or Reverse Holo or Common or Uncommon or Secret Rare or null",
  "confidence": {
    "player":     "high or medium or low",
    "cardSet":    "high or medium or low",
    "cardNumber": "high or medium or low",
    "parallel":   "high or medium or low"
  }
}
Rules:
- Card number is at the bottom left or bottom right of the card
- Set symbol identifies the expansion — describe the set name from it
- Rarity symbol (circle=Common, diamond=Uncommon, star=Rare) helps identify parallel type
- HP is printed in the top right of the card
- If this is a graded slab, read the PSA/CGC/BGS label for all details
- year must be an integer or null, grade must be a number or null, hp must be an integer or null`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
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

  const { image, mediaType = 'image/jpeg' } = body;
  if (!image) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'parse_error', message: 'image field required' }) };
  }

  try {
    // Phase 1: sports prompt
    const phase1 = await callClaude(apiKey, image, mediaType, PROMPT_SPORTS);
    if (!phase1.success) return { statusCode: 200, body: JSON.stringify(phase1) };

    const card1 = phase1.card;
    const isTCG = card1.sport === 'Pokemon' || card1.sport === 'TCG';

    // Phase 2: re-call with TCG-specific prompt if needed
    if (isTCG) {
      const phase2 = await callClaude(apiKey, image, mediaType, PROMPT_TCG);
      if (!phase2.success) {
        // Fall through with phase1 result rather than failing entirely
        return {
          statusCode: 200,
          body: JSON.stringify({ ...phase1, isTCG: true, promptVariant: 'sports_fallback' }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ ...phase2, isTCG: true, promptVariant: 'tcg' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ...phase1, isTCG: false, promptVariant: 'sports' }),
    };

  } catch (err) {
    console.error('[vision-scan] unexpected error:', err.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: 'api_error', message: err.message }),
    };
  }
};

async function callClaude(apiKey, image, mediaType, prompt) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let rawText = '';
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
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text',  text: prompt },
          ],
        }],
      }),
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[vision-scan] Anthropic API error', res.status, detail);
      return { success: false, error: 'api_error', message: `Anthropic API error ${res.status}` };
    }

    const data = await res.json();
    rawText = data?.content?.[0]?.text || '';

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { success: false, error: 'timeout', message: 'Vision API timed out after 10 seconds' };
    }
    return { success: false, error: 'api_error', message: err.message };
  }

  // Strip markdown fences if Claude wrapped the JSON anyway
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let card;
  try {
    card = JSON.parse(cleaned);
  } catch {
    console.error('[vision-scan] JSON parse failed. Raw:', rawText.slice(0, 500));
    return { success: false, error: 'parse_error', message: 'Could not parse vision response as JSON', rawResponse: rawText };
  }

  // Check if all confidence values are low
  const conf = card.confidence || {};
  const confValues = Object.values(conf);
  if (confValues.length > 0 && confValues.every(v => v === 'low')) {
    return {
      success: false,
      error: 'low_confidence',
      message: 'Could not identify card with confidence — try better lighting',
      rawResponse: rawText,
    };
  }

  return { success: true, card, rawResponse: rawText };
}
