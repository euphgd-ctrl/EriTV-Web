/* Offline shell and course-content cache. API, SSH terminal, and VM actions
   always use the network and are never cached. */
const CACHE_PREFIX = 'linux-mastery-lab-pwa-';
const CACHE = CACHE_PREFIX + 'v4';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './offline-pack.json',
  './static/lesson.js', './static/command_anatomy.js', './static/pwa-bridge.js',
  './static/icons/icon.svg', './static/icons/icon-192.png', './static/icons/icon-512.png',
  './static/icons/apple-touch-icon.png',
];
const NEVER_CACHE = /\/api\/|\/socket\.io\/|\/terminal(?:\?|$)/i;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

function cacheResponse(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  caches.open(CACHE).then(cache => cache.put(request, response.clone())).catch(() => {});
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      cacheResponse('./index.html', response);
      return response;
    }).catch(() => caches.match('./index.html').then(response => response || Response.error())));
    return;
  }

  event.respondWith(fetch(request).then(response => {
    cacheResponse(request, response);
    return response;
  }).catch(() => caches.match(request).then(response => response || Response.error())));
});
