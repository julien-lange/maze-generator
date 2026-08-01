// Cache-first service worker, so the maze works with no signal at all — in the
// car, on a train, wherever. Bump VERSION whenever you republish a new pack or
// a new wasm build, or phones will happily keep serving yesterday's.

const VERSION = 'maze-v3';

const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'pack.json',
  'wasm_exec.js',
  'maze.wasm',
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // One asset at a time: addAll rejects the whole batch if a single file is
      // missing, and a missing icon should not cost us the offline maze.
      //
      // cache: 'reload' goes past the browser's own cache to the network. Pages
      // serves these with ten minutes of freshness, and without this a new
      // worker can dutifully install a copy of the version it is replacing.
      .then((c) => Promise.allSettled(
        ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request)
      .then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
      .catch(() => {
        // Offline, and not an exact hit. A navigation carrying a query string
        // or a hash still wants the page it would have been given.
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      })
  );
});
