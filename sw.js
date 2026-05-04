const STATIC_CACHE = 'gz-static-v1';
const RUNTIME_CACHE = 'gz-runtime-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/library.html',
  '/favorites.html',
  '/profile.html',
  '/style.css',
  '/app.js',
  '/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isImageRequest(request) {
  return request.destination === 'image' || /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(new URL(request.url).pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isImageRequest(request)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const networkFetch = fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        });
        return hit || networkFetch;
      })
    );
    return;
  }

  if (url.pathname.startsWith('/api/games') || url.pathname.startsWith('/api/featured') || url.pathname.startsWith('/api/categories')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).catch(() => caches.match('/index.html')))
  );
});
