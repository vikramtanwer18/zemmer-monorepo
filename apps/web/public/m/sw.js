// Member app service worker, scoped to /m/.
// Bump VERSION whenever this file changes so old caches are cleared.
const VERSION = "v2";
const CACHE = `gym-member-${VERSION}`;
const OFFLINE_URL = "/m/offline";
// Pages that must open without a connection (D-09: the card works in a basement). Their HTML
// carries no secrets; the pass itself lives in IndexedDB, written by the page.
const OFFLINE_PAGES = ["/m/card"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("gym-member-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build assets are content-hashed and immutable: cache first, so the card's code runs offline.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (request.mode !== "navigate") return;

  // Offline-capable pages: network first, keep the last good copy for offline use.
  if (OFFLINE_PAGES.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok && !response.redirected) {
            const cache = await caches.open(CACHE);
            await cache.put(url.pathname, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(url.pathname)) ??
            (await cache.match(OFFLINE_URL)) ??
            Response.error()
          );
        }),
    );
    return;
  }

  // Other pages: try the network, fall back to the cached offline page.
  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(OFFLINE_URL)) ?? Response.error();
    }),
  );
});
