// meta-graph.js — shared Meta Graph API client (IG Social Ingest spec, Phase 0).
// See "Instagram Social Ingest" in CLAUDE.md.
//
// Lives in netlify/lib/ next to social-pipeline.js (not netlify/functions/lib/
// as the spec suggested) so every shared module is in one place and Netlify
// never mistakes it for a function.
//
// Credentials: IG_ACCESS_TOKEN and META_GRAPH_VERSION are read from the
// environment here and nowhere else. The token is never logged, never put in
// an error message, and never returned to a caller: every URL that is logged
// goes through redactUrl(), and every error message goes through scrub().
//
//   graphGet(path, params, { db? })                → parsed JSON
//   graphPaginate(path, params, { stopWhen, maxPages, db? })
//                                                  → { items, pages, stopped }
//   recordHealth(db, status, detail)               → writes integration_health
//   healthStatusFor(err)                           → 'token_invalid' | ...
//
// Retries: network errors and HTTP 5xx are retried 3 times (after 1s, 2s, 4s).
// Meta error codes are mapped to typed errors and never retried:
//   190                    → TokenError       (integration_health 'token_invalid')
//   10, 200-299            → PermissionError  (integration_health 'permission_missing')
//   4, 17, 32, 613         → RateLimitError   (integration_health 'rate_limited')
//   anything else          → GraphError
// When a db (service-role Supabase client) is passed, a typed error also writes
// an integration_health row before it is thrown.

const GRAPH_HOST = 'https://graph.facebook.com';
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 8000;

class GraphError extends Error {
  constructor(message, { code = null, subcode = null, httpStatus = null, type = null } = {}) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.subcode = subcode;
    this.httpStatus = httpStatus;
    this.type = type;
  }
}
class TokenError extends GraphError { constructor(m, o) { super(m, o); this.name = 'TokenError'; } }
class PermissionError extends GraphError { constructor(m, o) { super(m, o); this.name = 'PermissionError'; } }
class RateLimitError extends GraphError { constructor(m, o) { super(m, o); this.name = 'RateLimitError'; } }

function graphVersion() {
  return process.env.META_GRAPH_VERSION || 'v23.0';
}

function token() {
  const t = process.env.IG_ACCESS_TOKEN;
  if (!t) throw new TokenError('IG_ACCESS_TOKEN is not set', { code: 190 });
  return t;
}

// Remove the token (and any app secret proof) from a URL before it is logged.
function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of ['access_token', 'appsecret_proof', 'client_secret']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch (_) {
    return String(url).replace(/(access_token|appsecret_proof|client_secret)=[^&\s]+/gi, '$1=REDACTED');
  }
}

// Belt and braces: strip the literal token / app secret from any text we log or throw.
const _extraSecrets = new Set();
function scrub(text) {
  let s = String(text ?? '');
  for (const secret of _extraSecrets) s = s.split(secret).join('REDACTED');
  for (const secret of [process.env.IG_ACCESS_TOKEN, process.env.META_APP_SECRET]) {
    if (secret && secret.length >= 8) s = s.split(secret).join('REDACTED');
  }
  return s.replace(/(access_token|appsecret_proof|client_secret)=[^&\s"']+/gi, '$1=REDACTED');
}

// Build https://graph.facebook.com/{version}/{path}?... with URLSearchParams, so
// braces and parentheses in `fields` (e.g. media.limit(5){caption}) are
// percent-encoded correctly.
function buildUrl(path, params = {}, accessToken = null) {
  const clean = String(path || '').replace(/^\/+/, '');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  qs.set('access_token', accessToken || token());
  return `${GRAPH_HOST}/${graphVersion()}/${clean}?${qs.toString()}`;
}

function typedError(body, httpStatus) {
  const e = body?.error || {};
  const code = Number(e.code);
  const opts = { code: Number.isFinite(code) ? code : null, subcode: e.error_subcode ?? null, httpStatus, type: e.type || null };
  const msg = scrub(`Meta Graph error ${opts.code ?? '?'}${opts.subcode ? '/' + opts.subcode : ''} (HTTP ${httpStatus}): ${e.message || 'unknown error'}`);
  if (code === 190) return new TokenError(msg, opts);
  if (code === 10 || (code >= 200 && code <= 299)) return new PermissionError(msg, opts);
  if ([4, 17, 32, 613].includes(code)) return new RateLimitError(msg, opts);
  return new GraphError(msg, opts);
}

function healthStatusFor(err) {
  if (err instanceof TokenError) return 'token_invalid';
  if (err instanceof PermissionError) return 'permission_missing';
  if (err instanceof RateLimitError) return 'rate_limited';
  return 'error';
}

async function recordHealth(db, status, detail, integration = 'meta_graph') {
  if (!db) return;
  try {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
    const { error } = await db.from('integration_health').insert({ integration, status, detail: scrub(text).slice(0, 2000) });
    if (error) console.warn('[meta-graph] integration_health insert failed:', scrub(error.message));
  } catch (err) {
    console.warn('[meta-graph] integration_health insert failed:', scrub(err.message));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request with retries. `url` is a full URL (already carrying the token,
// e.g. a paging.next link). Never logs or throws the raw URL.
async function fetchGraph(url, { db, accessToken } = {}) {
  if (accessToken && accessToken.length >= 8) _extraSecrets.add(accessToken);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let res, body;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        body = await res.json().catch(() => null);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = new GraphError(scrub(`network error calling ${redactUrl(url)}: ${err.name === 'AbortError' ? 'timeout' : err.message}`));
      console.warn(`[meta-graph] ${lastErr.message} (attempt ${attempt + 1})`);
      continue;
    }

    if (res.ok && body && !body.error) return body;

    if (res.status >= 500 && !(body?.error && isTyped(body.error.code))) {
      lastErr = new GraphError(scrub(`HTTP ${res.status} from ${redactUrl(url)}`), { httpStatus: res.status, code: body?.error?.code ?? null });
      console.warn(`[meta-graph] ${lastErr.message} (attempt ${attempt + 1})`);
      continue;
    }

    const err = typedError(body, res.status);
    if (db && !(err.constructor === GraphError)) await recordHealth(db, healthStatusFor(err), err.message);
    throw err;
  }
  throw lastErr || new GraphError('Meta Graph request failed');
}

function isTyped(code) {
  const c = Number(code);
  return c === 190 || c === 10 || (c >= 200 && c <= 299) || [4, 17, 32, 613].includes(c);
}

// opts.accessToken overrides IG_ACCESS_TOKEN for this one call (used for the
// oEmbed app token and the bad-token self-test). It is scrubbed like the main one.
async function graphGet(path, params = {}, opts = {}) {
  return fetchGraph(buildUrl(path, params, opts.accessToken), opts);
}

// Follow paging.next until there is no next page, maxPages is reached, or
// stopWhen(item, pageItems) returns true (it may be async). Items are
// collected up to, not including, the item that stopped the walk.
async function graphPaginate(path, params = {}, { stopWhen = null, maxPages = 20, db, accessToken } = {}) {
  const items = [];
  let url = buildUrl(path, params, accessToken);
  let pages = 0;
  while (url && pages < maxPages) {
    const body = await fetchGraph(url, { db, accessToken });
    pages++;
    const pageItems = Array.isArray(body?.data) ? body.data : [];
    for (const item of pageItems) {
      if (stopWhen && await stopWhen(item, pageItems)) return { items, pages, stopped: true };
      items.push(item);
    }
    url = body?.paging?.next || null;
  }
  return { items, pages, stopped: false, truncated: !!url };
}

module.exports = {
  graphGet, graphPaginate, fetchGraph, buildUrl, redactUrl, scrub,
  recordHealth, healthStatusFor, graphVersion,
  GraphError, TokenError, PermissionError, RateLimitError,
};
