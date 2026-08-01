// Cache-first service worker, so the maze works with no signal at all — in the
// car, on a train, wherever. Bump VERSION whenever you republish a new pack or
// a new wasm build, or phones will happily keep serving yesterday's.

const VERSION = 'maze-v3';

// Everything the maze needs to play with no signal at all. Taken as a batch:
// addAll rejects the lot if one file fails to arrive, which fails the install,
// which means this worker never activates and never gets as far as deleting the
// cache below. On a train with one bar that is the whole point — a version
// behind and working beats half a version and a hole where the wasm should be.
const ESSENTIAL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'pack.json',
  'wasm_exec.js',
  'maze.wasm',
];

// Dressing for the home screen, allowed to fail one at a time: a missing icon
// should never cost us the offline maze.
const EXTRAS = [
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
  'manifest.webmanifest',
];

// fresh goes past the browser's own cache to the network. Pages serves these
// with ten minutes of freshness, and without this a new worker can dutifully
// install a copy of the very version it is replacing.
const fresh = (a) => new Request(a, { cache: 'reload' });

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(ESSENTIAL.map(fresh))
        .then(() => Promise.allSettled(EXTRAS.map((a) => c.add(fresh(a))))))
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
