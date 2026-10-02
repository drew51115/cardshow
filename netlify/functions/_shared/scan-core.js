// Shared single-card scan core — one prompt, one schema, one validator.
// Used by scan-card.js (POS / Manual Sale / bulk slab-label pass) and
// vision-scan.js (Add Card cert scanner). Both of those are thin adapters
// that keep their legacy response shapes.
//
// Not a Netlify function itself: Netlify only treats a subdirectory as a
// function when it contains index.js or a file named after the directory.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-6';
const MAX_TOKENS        = 1024;
// Must fire before Netlify's 10s synchronous function limit, with a little
// room left to return the timeout response. Measured on the deploy preview:
// a full-card read of a ~1568px crop takes ~7.8s end to end, so 8s was too
// tight and timed out on real photos.
const TIMEOUT_MS        = 9300;

const CONF_FIELDS = ['player_name', 'year', 'set_name', 'card_number', 'parallel_name', 'grade', 'cert_number'];

const nullableString = { type: ['string', 'null'] };

// Types only — no example values, so the model can't echo a placeholder back.
const RECORD_CARD_TOOL = {
  name: 'record_card',
  description: 'Record the details read from the trading card photo.',
  input_schema: {
    type: 'object',
    properties: {
      label_text:      { type: ['string', 'null'], description: 'Verbatim transcription of the grading label, or null if there is no label.' },
      item_type:       { type: 'string', enum: ['card', 'sealed', 'lot'] },
      category:        { type: ['string', 'null'], enum: ['Sports', 'TCG', 'Non-Sport', null] },
      subcategory:     nullableString,
      player_name:     nullableString,
      card_title:      nullableString,
      year:            nullableString,
      set_name:        nullableString,
      card_number:     nullableString,
      parallel_name:   nullableString,
      serial_number:   nullableString,
      print_run:       nullableString,
      autograph:       { type: 'boolean' },
      grading_company: nullableString,
      grade:           nullableString,
      grade_numeric:   { type: ['number', 'null'] },
      cert_number:     nullableString,
      confidence: {
        type: 'object',
        properties: Object.fromEntries(CONF_FIELDS.map(k => [k, { type: 'number', minimum: 0, maximum: 1 }])),
        required: CONF_FIELDS,
      },
    },
    required: [
      'label_text', 'item_type', 'category', 'subcategory', 'player_name', 'card_title', 'year',
      'set_name', 'card_number', 'parallel_name', 'serial_number', 'print_run', 'autograph',
      'grading_company', 'grade', 'grade_numeric', 'cert_number', 'confidence',
    ],
  },
};

const SYSTEM_PROMPT = `You read one trading card from a photo and record it with the record_card tool.
The card may be raw or inside a graded slab, and may be a sports card, a TCG card (Pokemon,
Magic: The Gathering, Yu-Gi-Oh!, One Piece, Lorcana, etc.) or a non-sport card.

Read before you interpret: if there is a grading label, transcribe it verbatim into label_text first.

Text:
- Return text exactly as printed, with its original capitalization. Do not lowercase.
- If a field is not clearly visible, return null. Never guess.
- Read the player or character name from the text printed on the card or label. Never infer it
  from the team, uniform, logo or photo — two players on the same team are easy to confuse. If
  the printed name is not legible, return null.

Grading:
- grading_company is whatever company name is on the label (PSA, BGS, SGC, CGC, TAG, HGA, CSG, or any other).
- grade is the card grade as printed ("10", "9.5", "Authentic"). On dual-grade slabs (card + autograph), grade is the card grade, never the auto grade. grade_numeric is that card grade as a number, or null if it isn't numeric.
- If a slab is visible but the grade is not legible, return grading_company and grade: null.
- If the card is raw, grading_company, grade, grade_numeric and cert_number are all null.

Cert number vs. other numbers (these are often confused):
- cert_number is printed on the grading label. It is never the "45/99" serial printed on the card, and never the card's number within its set.
- If any digit of the cert number is not clearly legible, return cert_number: null. A partial or guessed cert number is worse than none.
- card_number is the card's own number within its set (e.g. "150", "BCP-196"; for TCG it is in a bottom corner, e.g. "025/198").
- serial_number and print_run come from a stamped serial like "45/99": serial_number "45", print_run "99". Do not put the print run in parallel_name.

Variants:
- autograph is true if there is a signature, sticker auto, or AUTO stamp anywhere on the card.
- parallel_name is the variant only (e.g. "Gold Refractor", "Reverse Holo", "Special Illustration Rare"). Colored borders and foil patterns (refractor, prizm, holo) indicate a parallel. Null for a base card.

TCG:
- For TCG cards, player_name is the character or card name and card_title is the full card name (e.g. "Charizard ex").
- The set symbol identifies the expansion; the rarity symbol helps identify the variant.

Classification:
- category is Sports, TCG or Non-Sport. subcategory is the sport, game or franchise (e.g. "Baseball", "Pokemon", "Marvel").
- item_type is "sealed" for sealed product, "lot" for several cards together, else "card".

confidence: 0 to 1 per field, reflecting how legible and certain each value is. Use 0 for a null field.`;

// Starting values — verify against the eval slab fixtures before relying on them.
const CERT_LENGTHS = {
  PSA:   [7, 9],
  SGC:   [7, 8],
  BGS:   [7, 10],
  CGC:   [10, 10],
  other: [5, 16],
};
const NUMERIC_CERT_GRADERS = ['PSA', 'BGS', 'SGC', 'CGC'];

function normalizeGraderKey(company) {
  const g = String(company || '').trim().toUpperCase();
  if (/^PSA\b/.test(g)) return 'PSA';
  if (/^(BGS|BECKETT)\b/.test(g)) return 'BGS';
  if (/^SGC\b/.test(g)) return 'SGC';
  if (/^CGC\b/.test(g)) return 'CGC';
  return g;
}

function digitsOnly(s) { return String(s || '').replace(/[\s-]/g, ''); }

// Returns { card, flags }. Never drops a value — a failed check zeroes the
// cert confidence so the client asks the seller to confirm it.
function validateCard(card) {
  const flags = [];
  const out = { ...card, confidence: { ...(card.confidence || {}) } };

  if (out.cert_number != null && String(out.cert_number).trim() !== '') {
    const cert = digitsOnly(out.cert_number);
    out.cert_number = cert;
    const key = normalizeGraderKey(out.grading_company);

    if (!out.grading_company) flags.push('cert_without_grader');

    if (NUMERIC_CERT_GRADERS.includes(key)) {
      if (!/^\d+$/.test(cert)) flags.push('cert_format');
    } else if (!/^[A-Za-z0-9]+$/.test(cert)) {
      flags.push('cert_format');
    }

    const [min, max] = CERT_LENGTHS[key] || CERT_LENGTHS.other;
    if (cert.length < min || cert.length > max) flags.push('cert_length');

    const serial = digitsOnly(out.serial_number);
    const run    = digitsOnly(out.print_run);
    const lookalikes = [digitsOnly(out.card_number), serial, serial && run ? `${serial}/${run}` : '', serial && run ? serial + run : '']
      .filter(Boolean);
    if (lookalikes.includes(cert)) flags.push('cert_equals_serial');

    if (flags.length) out.confidence.cert_number = 0;
  } else {
    out.cert_number = null;
  }

  return { card: out, flags };
}

// Label-only mode (bulk scan pass 2 on a cropped slab): far smaller output
// than record_card, so it returns well inside the Netlify timeout.
const LABEL_CONF_FIELDS = ['grade', 'cert_number'];
const RECORD_LABEL_TOOL = {
  name: 'record_label',
  description: 'Record what is printed on the grading label of the slab in the photo.',
  input_schema: {
    type: 'object',
    properties: {
      center_is_slab:  { type: 'boolean', description: 'True only if the card at the CENTER of the image is inside a grading slab with a printed grading label.' },
      label_text:      { type: ['string', 'null'], description: 'Verbatim transcription of the grading label, or null if there is no label.' },
      label_player:    { type: ['string', 'null'], description: 'The player or character name printed on the label, or null.' },
      label_box: {
        type: ['object', 'null'],
        description: 'Where the grading label of the center slab is in the image, as fractions 0-1 of image width/height (x,y = top-left corner). Null if there is no label.',
        properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        required: ['x', 'y', 'w', 'h'],
      },
      grading_company: nullableString,
      grade:           nullableString,
      grade_numeric:   { type: ['number', 'null'] },
      cert_number:     nullableString,
      confidence: {
        type: 'object',
        properties: Object.fromEntries(LABEL_CONF_FIELDS.map(k => [k, { type: 'number', minimum: 0, maximum: 1 }])),
        required: LABEL_CONF_FIELDS,
      },
    },
    required: ['center_is_slab', 'label_text', 'label_player', 'label_box', 'grading_company', 'grade', 'grade_numeric', 'cert_number', 'confidence'],
  },
};

const LABEL_PROMPT = `You read the grading label on one graded trading card slab and record it with the record_label tool.
- Transcribe the label verbatim into label_text first, then fill the other fields from it.
- grading_company is the company named on the label or slab (PSA, BGS, SGC, CGC, TAG, HGA, CSG, or any other). PSA labels are red-bordered with "PSA"; CGC labels say "CGC"; BGS labels say "BECKETT". Read it, do not guess.
- grade is the card grade as printed ("10", "9.5", "Authentic"). On dual-grade labels, the card grade, not the auto grade. grade_numeric is that grade as a number, or null.
- cert_number is the certification number printed on the label (often next to a barcode). It is never a "45/99" serial and never the card number.
- If any digit of the cert number is not clearly legible, return cert_number: null. A partial or guessed cert number is worse than none.
- Only the card at the center of the image counts. Slabs or cards cut off at the edges belong to other cards: never read their labels.
- center_is_slab is false when the center card is raw (no slab), in a top loader, a penny sleeve, a magnetic one-touch or any holder without a grading label. Then return nulls for every label field.
- label_player is the name printed on the label, so the caller can confirm the label belongs to the right card.
- label_box locates the center slab's label so it can be re-photographed closer.
- confidence: 0 to 1 for grade and cert_number. Use 0 for a null field.`;

// Locate mode (bulk scan): find ONE described card inside a region cut from a
// showcase photo and return where it is, so the caller can re-crop it tightly
// at full resolution before reading it. Tiny output — returns in a few seconds.
const BOX = {
  type: ['object', 'null'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
  required: ['x', 'y', 'w', 'h'],
};
const RECORD_LOCATION_TOOL = {
  name: 'record_location',
  description: 'Record where the target card is in the image.',
  input_schema: {
    type: 'object',
    properties: {
      found:      { type: 'boolean', description: 'True if the target card is in the image.' },
      card_box:   { ...BOX, description: 'The whole target card (or whole slab, label included), as fractions 0-1 of image width/height; x,y = top-left corner. Null if not found.' },
      is_slab:    { type: 'boolean', description: 'True if the target card is inside a grading slab with a printed label.' },
      label_box:  { ...BOX, description: "The target slab's grading label, same units. Null if not a slab." },
      card_count: { type: 'integer', description: 'How many cards or slabs are fully or partly visible in the image.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are that card_box is the target card.' },
    },
    required: ['found', 'card_box', 'is_slab', 'label_box', 'card_count', 'confidence'],
  },
};
const LOCATE_PROMPT = `You locate one trading card in a photo of several cards and record it with the record_location tool.
- The user describes the target card. The description comes from a quick first look and may contain mistakes; use it with the card's position to pick the right card.
- The target is usually the card closest to the center of the image. Cards at the edges are usually neighbors.
- card_box must tightly enclose the whole target card, or the whole slab including its grading label. Coordinates are fractions of the image width and height, x,y the top-left corner.
- label_box encloses only the grading label (the printed strip at the top of a slab with the grade, name and cert number). Null if the card is not in a grading slab.
- A card in a top loader, penny sleeve or magnetic holder is not a slab.
- If none of the cards matches the description, choose the card closest to the center and lower confidence.`;

const SHOWCASE_CROP_NOTE = 'This image was cropped from a photo of many cards laid out together. Parts of neighboring cards or slabs may show at the edges. Describe ONLY the card at the center of the image and ignore everything at the edges.';

async function scanCard({ imageBase64, mediaType = 'image/jpeg', labelImageBase64 = null, mode = 'card', fromShowcase = false, target = '', apiKey = process.env.ANTHROPIC_API_KEY }) {
  const labelMode  = mode === 'label';
  const locateMode = mode === 'locate';
  const tool   = locateMode ? RECORD_LOCATION_TOOL : labelMode ? RECORD_LABEL_TOOL : RECORD_CARD_TOOL;
  const system = locateMode ? LOCATE_PROMPT : labelMode ? LABEL_PROMPT : SYSTEM_PROMPT;
  const t0 = Date.now();
  if (!apiKey) return { success: false, error: 'api_error', message: 'ANTHROPIC_API_KEY not configured' };
  if (!imageBase64) return { success: false, error: 'parse_error', message: 'image required' };

  const content = locateMode ? [
    { type: 'text', text: `Target card: ${String(target || 'unknown').slice(0, 300)}` },
  ] : [
    ...(fromShowcase ? [{ type: 'text', text: SHOWCASE_CROP_NOTE }] : []),
    { type: 'text', text: 'Image 1: the full card.' },
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
  ];
  if (locateMode) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
  if (labelImageBase64 && !locateMode) {
    content.push(
      { type: 'text', text: 'Image 2: a close-up crop of the top of the same card, where a grading label would be. Use it to read the label text, grade and cert number.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: labelImageBase64 } },
    );
  }
  content.push({ type: 'text', text: locateMode ? 'Locate the target card with the record_location tool.'
    : labelMode ? 'Record this label with the record_label tool.' : 'Record this card with the record_card tool.' });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let data;
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
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        temperature: 0,
        system,
        tools:       [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages:    [{ role: 'user', content }],
      }),
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[scan-core] Anthropic API error', res.status, detail.slice(0, 500));
      return { success: false, error: res.status === 429 ? 'rate_limited' : 'api_error', status: res.status, message: `Anthropic API error ${res.status}` };
    }
    data = await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn('[scan-core] timed out', { mode, ms: Date.now() - t0 });
      return { success: false, error: 'timeout', message: `Card scan timed out after ${TIMEOUT_MS / 1000} seconds`, elapsed_ms: Date.now() - t0 };
    }
    return { success: false, error: 'api_error', message: err.message };
  }

  const elapsed_ms = Date.now() - t0;
  const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!toolBlock || !toolBlock.input || typeof toolBlock.input !== 'object') {
    console.error('[scan-core] no record_card tool_use block; stop_reason:', data.stop_reason);
    return { success: false, error: 'parse_error', message: 'Scan returned no card record' };
  }

  if (locateMode) return { success: true, location: toolBlock.input, elapsed_ms, mode: 'locate' };
  const { card, flags } = validateCard(toolBlock.input);
  return { success: true, card, flags, elapsed_ms, mode: labelMode ? 'label' : 'card' };
}

module.exports = { scanCard, validateCard, CERT_LENGTHS, RECORD_CARD_TOOL, SYSTEM_PROMPT, MODEL };
