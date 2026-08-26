const CACHE = "ghostvoice-shell-v4";
const STATIC = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/profile.js",
  "/static/profile.css",
  "/static/admin.js",
  "/static/admin.css",
  "/static/manifest.webmanifest",
  "/static/ghostvoice-logo.png",
  "/static/ghostvoice-128.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
