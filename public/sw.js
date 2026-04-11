'use strict';

const CACHE  = 'arvl-v73';
const SHELL  = [
  '/',
  '/style.css',
  '/js/common.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
];

// ── Install: pre-cache the app shell ─────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────
// Static assets (CSS, JS, images, fonts) → cache-first
// HTML pages + API calls                 → network-first, fall back to cache/offline
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls → always network, never cache
  if (url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/albums/') ||
      url.pathname.startsWith('/recommendations') ||
      url.pathname.startsWith('/notifications') ||
      url.pathname.startsWith('/community') ||
      url.pathname.startsWith('/u/') ||
      url.pathname.startsWith('/likes/') ||
      url.pathname.startsWith('/crate') ||
      url.pathname.startsWith('/listen')) {
    return; // let browser handle normally
  }

  // Static assets (CSS, JS, images) → cache-first
  if (url.pathname.match(/\.(css|js|png|svg|ico|woff2?)(\?.*)?$/)) {
    e.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // HTML pages → network-first, offline fallback
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then(cached => cached || caches.match('/offline.html'))
      )
    );
  }
});
