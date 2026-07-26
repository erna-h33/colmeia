const CACHE_NAME = 'beehive-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

// Network-first: always fetch the latest version when online (and quietly
// refresh the cache in the background). Only falls back to the cached copy
// if the network request fails -- i.e. genuinely offline. This matters most
// during active development, where a cache-first strategy would keep
// serving stale files no matter how many times you edit and reload.
//
// Same-origin only: this SW re-issues intercepted requests via its own
// fetch(), which is subject to the page's CSP connect-src. Letting it
// touch cross-origin requests (Google Fonts, the Supabase JS CDN, the
// Supabase API itself) means any of those not explicitly allowlisted in
// connect-src gets silently CSP-blocked here -- breaking font loading and,
// worse, causing the app to think Supabase failed to load and silently
// fall back to local-only storage. Third-party requests were never part
// of the offline-asset list below anyway, so just leave them alone.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  const isGet = request.method === 'GET';
  const isSameOrigin = url.origin === self.location.origin;

  if (!isHttp || !isGet || !isSameOrigin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
