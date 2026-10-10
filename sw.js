/* EriTV Web service worker.
 *
 * Caches the app shell (HTML/JS/manifest/icons) for offline launch.
 * The HLS stream (.m3u8 playlists, .ts/.m4s segments) and all cross-origin
 * requests (e.g. the hls.js CDN) are NEVER cached -- they always go to the
 * network so playback is never served stale media.
 *
 * Caching strategy:
 *  - Navigations: network-first, falling back to the cached app shell, and
 *    the fresh copy is stored so the offline shell stays current.
 *  - player.js: network-first with cached fallback for prompt player fixes.
 *  - Other same-origin GETs: stale-while-revalidate -- serve the cached copy
 *    instantly, refresh it in the background for next time.
 */
const CACHE = 'eritv-shell-v7';
const ASSETS = [
  './',
  './index.html',
  './player.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const NEVER_CACHE = /\.m3u8($|\?)|\.ts($|\?)|\.m4s($|\?)|\.mpd($|\?)/i;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

function cachePut(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE).then(function (c) { return c.put(request, copy); }).catch(function () {});
}

self.addEventListener('fetch', function (e) {
  const url = e.request.url;
  if (typeof url !== 'string' || !url.startsWith('http')) return;
  const u = new URL(url);
  if (u.origin !== self.location.origin) return; // HLS stream + CDN: network only
  if (e.request.method !== 'GET') return;
  if (NEVER_CACHE.test(u.pathname)) return;      // never cache media playlists/segments

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (r) { cachePut('./index.html', r); return r; })
        .catch(function () { return caches.match('./index.html').then(function (r) { return r || Response.error(); }); })
    );
    return;
  }

  // Player fixes should reach installed PWAs immediately after a reload.
  // Keep an offline copy, but prefer fresh code over a stale cached player.
  if (u.pathname.endsWith('/player.js')) {
    e.respondWith(
      fetch(e.request).then(function (response) {
        cachePut(e.request, response);
        return response;
      }).catch(function () {
        return caches.match(e.request).then(function (cached) { return cached || Response.error(); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      const network = fetch(e.request).then(function (r) { cachePut(e.request, r); return r; })
        .catch(function () { return cached; });
      return cached || network;
    })
  );
});
