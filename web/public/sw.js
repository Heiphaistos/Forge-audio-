/*
 * Forge Audio service worker: keeps the app shell (index.html + its hashed /assets/ files) so the
 * player opens without network and offers the titles downloaded on this device (IndexedDB).
 *
 * - /api/* is NEVER intercepted nor cached (sessions, library, audio streams): requests go straight
 *   to the network, exactly as without a service worker.
 * - Pages: network first, so every deployment shows at once; the saved copy is only used when the
 *   server cannot be reached. Each fresh index.html refreshes the saved shell and drops old assets.
 * - /assets/*: names carry a content hash, a saved copy is always right (cache first).
 */
const CACHE = 'forge-shell-v1';
const EXTRA = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(refresh().catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Save index.html with everything it loads (scripts, styles, fonts named in the styles). */
async function refresh(response) {
  const cache = await caches.open(CACHE);
  const res = response || await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return;
  const html = await res.clone().text();
  const assets = new Set(html.match(/\/assets\/[^"'\s>)]+/g) || []);
  for (const a of [...assets]) {
    if (!a.endsWith('.css')) continue;
    const hit = await cache.match(a);
    const css = hit || await fetch(a, { credentials: 'same-origin' });
    if (!css.ok) continue;
    if (!hit) await cache.put(a, css.clone());
    for (const f of (await css.text()).match(/\/fonts\/[^"')\s]+/g) || []) EXTRA.includes(f) || EXTRA.push(f);
  }
  for (const a of assets) if (!(await cache.match(a))) await cache.add(a);
  for (const e of EXTRA) if (!(await cache.match(e))) await cache.add(e).catch(() => {});
  // Only now (everything it needs is saved) replace the page, then forget the previous build's files.
  await cache.put('/', res);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !assets.has(path)) await cache.delete(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // The app itself (single page: every path without a file extension).
  if (req.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) event.waitUntil(refresh(res.clone()).catch(() => {}));
        else if (res.status >= 500) return (await caches.match('/')) || res;
        return res;
      } catch (err) {
        const saved = await caches.match('/');
        if (saved) return saved;
        throw err;
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req)));
    return;
  }

  // Fonts, icons, manifest: fresh when online, saved copy otherwise.
  if (url.pathname.startsWith('/fonts/') || EXTRA.includes(url.pathname)) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then((c) => c.put(url.pathname, copy))); }
      return res;
    }, async (err) => (await caches.match(url.pathname, { ignoreVary: true })) || Promise.reject(err)));
  }
});
