// trade-og.js
// GET /trade/:id (rewritten here via _redirects: /trade/:id → this function
// with ?id=:id). Serves pre-rendered HTML carrying og:image/og:title so
// social crawlers (Instagram, X, iMessage, Discord, etc.) — which never
// execute JS — get a real link preview for a confirmed Trade Zone trade.
// A real human visitor is redirected straight into the SPA.
//
// Uses the public anon key only. The `trades` RLS select policy already
// allows anyone to read a row once confirmed_at is not null (see the
// Trade Zone migration) — no service key needed here.

const { createClient } = require('@supabase/supabase-js');

const SITE_URL = 'https://getcardshow.com';
const DEFAULT_IMAGE = `${SITE_URL}/og-trade-zone.png`;

// Known social/link-preview crawlers — everything else is treated as a
// human browser and redirected straight to the SPA.
const BOT_UA_RE = /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|WhatsApp|TelegramBot|LinkedInBot|Pinterest|SkypeUriPreview|vkShare|redditbot|Googlebot|bingbot|Applebot|iMessage/i;

exports.handler = async (event) => {
  const id = event.queryStringParameters?.id;
  const ua = event.headers['user-agent'] || event.headers['User-Agent'] || '';
  const isBot = BOT_UA_RE.test(ua);
  const spaUrl = `${SITE_URL}/trade-zone.html?trade=${encodeURIComponent(id || '')}`;

  if (!id) {
    return { statusCode: 302, headers: { Location: `${SITE_URL}/trade-zone.html` } };
  }

  // Humans skip the DB round-trip entirely — straight into the SPA.
  if (!isBot) {
    return { statusCode: 302, headers: { Location: spaUrl } };
  }

  let title = 'A trade on CardShow';
  let description = 'Two collectors made a trade on the CardShow Trade Zone.';
  let image = DEFAULT_IMAGE;

  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      const { data: trade } = await db
        .from('trades')
        .select('id, show_id, share_image_url, confirmed_at')
        .eq('id', id)
        .maybeSingle();

      if (trade?.share_image_url) image = trade.share_image_url;

      if (trade?.show_id) {
        const { data: show } = await db
          .from('trade_zone_shows')
          .select('name, location')
          .eq('id', trade.show_id)
          .maybeSingle();
        if (show?.name) {
          title = `A trade from ${show.name}`;
          description = show.location
            ? `Two collectors made a trade at ${show.name} (${show.location}) via CardShow Trade Zone.`
            : `Two collectors made a trade at ${show.name} via CardShow Trade Zone.`;
        }
      }
    } catch (err) {
      console.warn('[trade-og] lookup failed, serving default card:', err.message);
    }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CardShow">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(`${SITE_URL}/trade/${id}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(spaUrl)}">
</head>
<body>
<p>Redirecting to <a href="${esc(spaUrl)}">CardShow Trade Zone</a>&hellip;</p>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    body: html,
  };
};
