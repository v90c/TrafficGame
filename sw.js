const CACHE_NAME = 'lanedodger-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Network-first: always prefer the latest deployed code when online, so
  // updates show up immediately. Build a fresh Request from just the URL
  // (rather than passing event.request + {cache:'no-store'}) -- browsers
  // reject constructing a new Request that would inherit mode:'navigate'
  // from a navigation's event.request, which made that combination throw
  // and broke the offline fallback entirely. A plain fetch(event.request)
  // can still be silently satisfied by the browser's own HTTP cache, which
  // defeats "network-first", so cache:'no-store' is still needed -- just
  // via a clean Request that never carries a navigate mode.
  event.respondWith(
    fetch(new Request(event.request.url, { cache: 'no-store' }))
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
