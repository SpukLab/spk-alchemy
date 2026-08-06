/**
 * Offline-first shell. Everything the app needs is cached on install, so the
 * laboratory opens and runs with no network at all — which is the point: you
 * capture material wherever you are, not wherever there is signal.
 *
 * There is no server sync in this phase. All data lives in IndexedDB on the
 * device.
 */
const CACHE = 'alchemy-shell-v1';
const SHELL = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && new URL(request.url).origin === self.location.origin) {
        (await caches.open(CACHE)).put(request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match('./index.html')) ?? Response.error();
    }
  })());
});
