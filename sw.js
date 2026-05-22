/**
 * sw.js — Service Worker
 * ======================
 * Cache-first strategy: serves from cache when offline,
 * fetches from network when online and updates the cache.
 *
 * To force users to get a new version, bump CACHE_NAME.
 */

const CACHE_NAME = 'medtracker-v4';

// All files that must be available offline after first visit
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/calc.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
];

// Install: pre-cache all app shell files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting(); // activate immediately
});

// Activate: delete old caches from previous versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: cache-first, fall back to network
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin resources
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      // Not in cache — fetch and cache for next time
      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return response;
        })
        .catch(() => {
          // Network failed and not cached — return offline fallback for pages
          if (event.request.headers.get('accept')?.includes('text/html')) {
            return caches.match('./index.html');
          }
        });
    })
  );
});
