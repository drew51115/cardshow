// Supabase Edge Function: bulk-scan
// POST multipart/form-data { image: File } (Authorization: Bearer <supabase JWT>)
// Returns { cards: [...], count: N } — cards identified by Claude vision,
// pre-mapped to the CardShow 7-field fingerprint schema
// (player|year|set|cardNumber|parallel|grade|grader, all lowercase).
//
// Phase 1 of the bulk showcase scan feature. renderBulkScanReview(cards) in
// app.html is the Phase 2 integration point (review UI + inventory write path).

import { createClient } from "@supabase/supabase-js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;
const ANTHROPIC_TIMEOUT_MS = 45000; // showcase photos with many cards take longer than a single-card scan

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — raw upload size
const MAX_BASE64_CHARS = 5 * 1024 * 1024 * (4 / 3); // ~6.7M chars, roughly 5MB of encoded data

const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

const SYSTEM_PROMPT = `You are a sports card identification expert. Analyze the image and
identify every individual trading card visible. Return ONLY a valid
JSON array — no markdown, no explanation, no preamble.

For each card include these fields (all string values, all lowercase):
- player: full player name
- year: 4-digit year
- set: set name (e.g. 'topps chrome', 'bowman chrome', 'prizm')
- cardNumber: card number if visible, else empty string
- parallel: parallel or variation, including any visible serial number or print run (e.g. 'base', 'refractor', 'gold refractor auto /50', 'green refractor auto #'d/99')
- grade: numeric grade if graded slab, else empty string
- grader: grading company if graded (psa/bgs/sgc/cgc), else empty string
- certNumber: the cert/serial number printed on a graded slab's label (usually a 7-10 digit number, sometimes with a barcode above it), else empty string
- confidence: 'high', 'medium', or 'low'
- notes: brief note on anything the seller should verify, else empty string

Rules:
- PARALLELS AND SERIAL NUMBERS: colored borders, foil patterns (refractor, prizm, holo), and print runs are all parallel indicators. If a serial number or print run is visible anywhere on the card (e.g. '/50', '/99', '#'d/25'), always append it to the parallel field exactly as printed — e.g. 'gold refractor auto /50', not just 'gold refractor auto'.
- GRADED SLABS: if the card is in a graded slab (PSA, BGS, CGC, or SGC label visible), always read the grade number directly off the label and populate both grade and grader — never leave grade empty for a visibly graded slab. Also read the cert number printed on the label into certNumber — this is critical for verifying the card against the grading company's database, so read it carefully digit by digit.
- If a field is not clearly visible or identifiable, return an empty string — do not guess.

If no cards are visible, return an empty array: []`;

const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https:\/\/(www\.)?getcardshow\.com$/i,
  /^https:\/\/[a-z0-9-]+(--[a-z0-9-]+)?\.netlify\.app$/i,
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = origin && ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin))
    ? origin
    : "https://getcardshow.com";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Only POST is supported" }, 405, origin);
  }

  try {
    return await handleScan(req, origin);
  } catch (err) {
    console.error("[bulk-scan] unhandled error:", err instanceof Error ? err.message : err);
    return json({ error: "server_error", message: "Something went wrong processing the scan" }, 500, origin);
  }
});

async function handleScan(req: Request, origin: string | null): Promise<Response> {
  // ── AUTH — reject before touching the image ──
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "unauthorized", message: "Missing or invalid Authorization header" }, 401, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("[bulk-scan] SUPABASE_URL / SUPABASE_ANON_KEY not set");
    return json({ error: "server_error", message: "Server misconfigured" }, 500, origin);
  }

  const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !user) {
    return json({ error: "unauthorized", message: "Invalid or expired session" }, 401, origin);
  }

  // ── INTAKE ──
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: "bad_request", message: "Expected multipart/form-data" }, 400, origin);
  }

  const image = formData.get("image");
  if (!(image instanceof File)) {
    return json({ error: "bad_request", message: "Missing 'image' field" }, 400, origin);
  }

  if (image.size > MAX_FILE_BYTES) {
    return json({ error: "file_too_large", message: "Image exceeds 10MB limit" }, 413, origin);
  }

  const mediaType = image.type;
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    return json(
      { error: "unsupported_media_type", message: `Unsupported image type: ${mediaType || "unknown"} — use JPEG, PNG, or WebP` },
      415,
      origin,
    );
  }

  // ── IMAGE PREPROCESSING ──
  const bytes = new Uint8Array(await image.arrayBuffer());
  const base64Image = bytesToBase64(bytes);

  if (base64Image.length > MAX_BASE64_CHARS) {
    return json(
      { error: "file_too_large", message: "Image too large — please use a photo under 4MB or split your showcase into two shots" },
      413,
      origin,
    );
  }

  // ── ANTHROPIC API CALL ──
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) {
    console.error("[bulk-scan] ANTHROPIC_API_KEY not set");
    return json({ error: "server_error", message: "Server misconfigured" }, 500, origin);
  }

  let rawText = "";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
              { type: "text", text: "Identify every trading card in this image and return the JSON array." },
            ],
          },
        ],
      }),
    });

    clearTimeout(timeoutId);

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text().catch(() => "");
      console.error("[bulk-scan] Anthropic API error", anthropicRes.status, detail);
      return json({ error: "api_error", message: `Anthropic API error ${anthropicRes.status}` }, 502, origin);
    }

    const data = await anthropicRes.json();
    rawText = (data?.content ?? [])
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("\n");
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[bulk-scan] Anthropic call timed out after", ANTHROPIC_TIMEOUT_MS, "ms");
      return json({ error: "timeout", message: "Vision API timed out — try a clearer photo or fewer cards per shot" }, 504, origin);
    }
    console.error("[bulk-scan] Anthropic call failed:", err instanceof Error ? err.message : err);
    return json({ error: "api_error", message: "Failed to reach Anthropic API" }, 502, origin);
  }

  // ── RESPONSE HANDLING ──
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[bulk-scan] JSON parse failed. Raw:", rawText.slice(0, 500));
    return json(
      { error: "parse_error", message: "Could not parse vision response as JSON", rawResponse: rawText },
      422,
      origin,
    );
  }

  if (!Array.isArray(parsed)) {
    return json(
      { error: "parse_error", message: "Vision response was not a JSON array", rawResponse: rawText },
      422,
      origin,
    );
  }

  const cards = parsed.map((card) => ({ id: crypto.randomUUID(), ...card }));

  return json({ cards, count: cards.length }, 200, origin);
}
