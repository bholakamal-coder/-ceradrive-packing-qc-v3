// ── Service Worker — Ceradrive v8.5.3 ──────────────────────────────────────
// Version bumped to match app version so the cache auto-updates on deploy.
const CACHE_NAME = "ceradrive-v8-5-3-cache-v1";
const ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json", "/assets/logo.jpeg"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))
    )
  );
  self.clients.claim();
});

// Network-first for API routes; cache-first for static assets.
self.addEventListener("fetch", e => {
  if (e.request.url.includes("/api/")) return; // always go network for API
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
