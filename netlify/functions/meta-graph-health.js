// meta-graph-health.js — admin-only check of the Meta Graph setup (IG Social Ingest, Phase 0).
// See "Instagram Social Ingest" in CLAUDE.md.
//
// POST { test: 'ping' | 'braces' | 'bad_token' } with the admin's Supabase JWT.
//   ping      GET /{IG_USER_ID}?fields=username,media_count  → { username, media_count }
//   braces    GET /{IG_USER_ID}?fields=media.limit(5){caption} → { captions: N } (brace encoding)
//   bad_token the same ping with a deliberately invalid token → expects TokenError and an
//             integration_health 'token_invalid' row
// Every test writes an integration_health row. No token is ever returned.

const P = require('../lib/social-pipeline');
const G = require('../lib/meta-graph');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return P.json(405, { success: false, error: 'method_not_allowed' });
  const db = P.getDb();
  if (!db) return P.json(503, { success: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });
  const admin = await P.requireAdmin(db, event);
  if (!admin) return P.json(401, { success: false, error: 'admin_only' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (_) { return P.json(400, { success: false, error: 'invalid_json' }); }
  const igUserId = process.env.IG_USER_ID;
  if (!igUserId) return P.json(500, { success: false, error: 'IG_USER_ID not set' });

  try {
    switch (input.test || 'ping') {
      case 'ping': {
        const r = await G.graphGet(igUserId, { fields: 'username,media_count' }, { db });
        await G.recordHealth(db, 'ok', { test: 'ping', username: r.username });
        return P.json(200, { success: true, username: r.username, media_count: r.media_count, graph_version: G.graphVersion() });
      }
      case 'braces': {
        const r = await G.graphGet(igUserId, { fields: 'media.limit(5){caption}' }, { db });
        const n = Array.isArray(r?.media?.data) ? r.media.data.length : 0;
        await G.recordHealth(db, 'ok', { test: 'braces', media_returned: n });
        return P.json(200, { success: true, media_returned: n, with_caption: (r?.media?.data || []).filter(m => m.caption).length });
      }
      case 'bad_token': {
        try {
          await G.graphGet(igUserId, { fields: 'username' }, { db, accessToken: 'EAAB_deliberately_invalid_token_for_testing' });
          return P.json(200, { success: false, error: 'bad token was accepted?' });
        } catch (err) {
          return P.json(200, { success: err instanceof G.TokenError, error_type: err.name, code: err.code, message: G.scrub(err.message) });
        }
      }
      default:
        return P.json(400, { success: false, error: 'unknown_test' });
    }
  } catch (err) {
    return P.json(502, { success: false, error_type: err.name, health_status: G.healthStatusFor(err), code: err.code ?? null, message: G.scrub(err.message) });
  }
};
