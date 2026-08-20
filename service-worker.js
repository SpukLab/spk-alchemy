/**
 * Offline shell with a network-first strategy for application code.
 *
 * The first version cached everything cache-first, which meant a broken build
 * kept being served from the device even after a fix was deployed: the stale
 * lab.js won over the network copy forever. Application code (HTML, JS, JSON)
 * is therefore fetched from the network first and only falls back to cache when
 * offline. Immutable assets (icons, manifest) stay cache-first.
 *
 * The laboratory still works with no network: the fallback covers that. What it
 * no longer does is trap the device on an old build.
 */
const CACHE = 'alchemy-shell-561a756';
const SHELL = [
  './', './index.html', './app.js', './lab.js', './export-orchestrator.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

/** Code must never be served stale in preference to a working deploy. */
const isCode = (url) => /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith('/');

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

self.addEventListener('message', (event) => {
  // The page can force a clean slate when a build looks wrong.
  if (event.data === 'clear-cache') {
    event.waitUntil((async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      for (const client of await self.clients.matchAll()) client.postMessage('cache-cleared');
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    if (isCode(url)) {
      // Network first: a deployed fix always wins over a cached failure.
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request))
          ?? (await caches.match('./index.html'))
          ?? Response.error();
      }
    }
    // Immutable assets: cache first.
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});
