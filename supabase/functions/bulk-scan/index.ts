// Supabase Edge Function: bulk-scan
// POST multipart/form-data { image: File } (Authorization: Bearer <supabase JWT>)
// Returns { cards: [...], count: N } — every card Claude vision finds in a
// showcase photo. Text comes back as printed (not lowercased). Each card has
// a normalized bbox so the client can crop graded slabs from the original
// full-resolution photo and read their labels in a second pass
// (_runSlabLabelPass() in app.html → scan-card.js).
//
// The client downsizes the photo to 1568px on the long edge before upload,
// so bbox coordinates line up with the client's own pixel space.

// Explicit npm: specifier (not the bare "@supabase/supabase-js" + deno.json import map)
// so the file deploys the same from the Supabase dashboard editor, which uploads
// index.ts alone, as from the CLI.
import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;
const ANTHROPIC_TIMEOUT_MS = 45000; // showcase photos with many cards take longer than a single-card scan

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — raw upload size
const MAX_BASE64_CHARS = 5 * 1024 * 1024 * (4 / 3); // ~6.7M chars, roughly 5MB of encoded data

const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

const SYSTEM_PROMPT = `You are a trading card identification expert covering sports cards, TCG cards
(Pokemon, Magic: The Gathering, Yu-Gi-Oh!, One Piece, Lorcana, etc.) and non-sport cards.
Analyze the image and identify every individual trading card visible. Return ONLY a valid
JSON array — no markdown, no explanation, no preamble.

For each card include these fields (string values unless noted):
- player: full player or character name, exactly as printed
- year: 4-digit year
- set: set name exactly as printed (e.g. 'Topps Chrome', 'Bowman Chrome', 'Prizm')
- cardNumber: the card's number within its set if visible, else empty string
- parallel: parallel or variation only (e.g. 'Refractor', 'Gold Refractor Auto'), else empty string. Do NOT put the serial number or print run here.
- serialNumber: the copy number from a stamped serial like '45/99' (here '45'), else empty string
- printRun: the total from that stamped serial (here '99'), else empty string
- grade: the card grade as printed on a graded slab's label (e.g. '9', '9.5', '10'), else empty string
- grader: the grading company name on the label (PSA, BGS, SGC, CGC, TAG, HGA, CSG or any other), else empty string
- certNumber: the cert number printed on a graded slab's label, else empty string
- bbox: object { x, y, w, h } — the box around the whole card or slab including its label, as fractions 0 to 1 of the image width and height, with x, y the top-left corner
- confidence: 'high', 'medium', or 'low'
- notes: brief note on anything the seller should verify, else empty string

Rules:
- Return text exactly as printed, with its original capitalization. Do not lowercase.
- Read each player or character name from the text printed on that card or its label. Never infer it from the team, uniform, logo or photo — two players on the same team are easy to confuse. If the printed name is not legible, return an empty string.
- TCG cards: player is the card or character name, set is the expansion name, and cardNumber is the number in a bottom corner (e.g. '025/198').
- GRADED SLABS: if a grading label is visible, fill grader. Fill grade only if the grade is legible; if it is not, leave grade empty.
- CERT NUMBERS: leave certNumber empty unless every digit is clearly legible. A partial or guessed cert number is worse than none. The cert number is never the '45/99' serial and never the card number.
- PARALLELS: colored borders and foil patterns (refractor, prizm, holo) indicate a parallel. If the card is signed or has an AUTO stamp, include 'Auto' in parallel.
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
        temperature: 0,
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
    if (data?.stop_reason === "max_tokens") {
      return json(
        { error: "too_many_cards", message: "Too many cards in one photo — split the showcase into two shots" },
        422,
        origin,
      );
    }
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

  // Drop anything that isn't a card object. A card without a usable bbox is
  // kept — it just can't take part in the client's slab-label pass.
  const cards = parsed
    .filter((card): card is Record<string, unknown> => !!card && typeof card === "object" && !Array.isArray(card))
    .map((card) => ({ id: crypto.randomUUID(), ...card, bbox: cleanBbox(card.bbox) }));

  return json({ cards, count: cards.length }, 200, origin);
}

function cleanBbox(b: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!b || typeof b !== "object") return null;
  const { x, y, w, h } = b as Record<string, unknown>;
  const nums = [x, y, w, h].map((v) => typeof v === "number" ? v : parseFloat(String(v)));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [nx, ny, nw, nh] = nums;
  if (nw <= 0 || nh <= 0 || nx < -0.05 || ny < -0.05 || nx + nw > 1.05 || ny + nh > 1.05) return null;
  return { x: nx, y: ny, w: nw, h: nh };
}
