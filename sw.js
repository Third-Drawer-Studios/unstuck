// Unstuck service worker — caches the app shell so it launches offline once installed.
// Bump CACHE on any release to invalidate the old shell.
const CACHE = 'unstuck-v17';
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './logic.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first so edits show up immediately; fall back to cache when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        // A 404 or 500 is a successful fetch of a bad answer, so it never reaches
        // the catch below. Serving it would replace the app with an error page and
        // cache that error forever — an unpublished host must not brick an install.
        if (!res || !res.ok) {
          return caches.match(req).then((cached) => cached || caches.match('./index.html') || res);
        }
        const copy = res.clone();
        // Refreshing the cached copy is best-effort — a full disk must not fail
        // the request the page is waiting on, but it does get reported.
        caches.open(CACHE)
          .then((c) => c.put(req, copy))
          .catch((err) => console.warn('Unstuck SW: could not cache', req.url, err));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});

// Tapping the timer's notification brings the app forward; without this the tap does nothing.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow('./');
    })
  );
});
