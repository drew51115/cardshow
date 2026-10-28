// CardShow service worker — keeps the app shell (app.html + its scripts, fonts
// and icons) loadable on weak or no show-floor signal. See CLAUDE.md
// "Show Mode v2 — Phase 1".
//
// Only the shell is cached. Supabase and Netlify function requests always go
// to the network (live inventory, sales and auth are never served from cache).
// app.html is network-first, so a fresh deploy is picked up on the next online
// load; the cached copy is only used when the network fails or is too slow.

const CACHE = 'cardshow-shell-v1';
const SHELL = [
  '/app.html',
  '/qrcode.min.js',
  '/manifest.webmanifest',
  '/assets/app-icon-192.png',
  '/assets/cardshow-emblem.png',
];
const NETWORK_TIMEOUT_MS = 4000;
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppNavigation(req, url) {
  return req.mode === 'navigate' && url.origin === self.location.origin &&
    (url.pathname === '/app' || url.pathname === '/app.html');
}

// Network-first with a timeout. A successful response refreshes the cache even
// if it arrives after the timeout already fell back to the cached copy.
function appShell(req) {
  const network = fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put('/app.html', copy));
    }
    return res;
  });
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => null), timeout]).then(res =>
    res || caches.match('/app.html').then(cached => cached || network)
  );
}

// Stale-while-revalidate for static scripts, fonts and images.
function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(cache =>
    cache.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isAppNavigation(req, url)) {
    event.respondWith(appShell(req));
    return;
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/.netlify/')) return;
    if (/\.(js|png|jpg|svg|webmanifest|woff2?)$/.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(req));
    }
    return; // other pages (index, show, seller-browse) are untouched
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // Everything else (Supabase, comp APIs) goes straight to the network.
});
