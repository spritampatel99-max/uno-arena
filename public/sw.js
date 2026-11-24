// UNO ARENA service worker.
// Purpose: let the game be installed, and keep the app shell on screen if the network blinks.
// It does NOT make the game playable offline: rooms live on the server and every move goes through it.
// Strategy: network first for the app's own files (so a new version is picked up straight away), falling back to the
// last copy we saw. The API and the live event stream are never cached or touched.
const CACHE = 'uno-arena-shell-v4';
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('uno-arena-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // fonts and anything else: the browser handles it
  if (url.pathname.startsWith('/api/')) return;             // game traffic and the event stream
  if (url.pathname === '/sw.js') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined) || Response.error())));
});
