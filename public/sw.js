/* My Reading Life — service worker
 *
 *  App shell + built files ... precached at install, cache-first (hashed files never change)
 *  index.html (navigation) ... network-first with a short timeout, cached copy as offline fallback
 *  Book covers (any host) .... cache-first, capped so storage never balloons
 *  Dictionary / Wikipedia .... cache-first for 30 days (definitions rarely change)
 *  Open Library / Google ..... cached for 12 hours, stale copy used when offline
 *  Google Fonts .............. cached after first load
 *
 * The build id and the list of built files are filled in by vite.config.ts at build time.
 * The page asks this worker for its build id (GET_BUILD) so it only prompts for an update when the CODE is different.
 */
const BUILD = '__BUILD_ID__';
let PRECACHE = [];
try { PRECACHE = JSON.parse('__PRECACHE_LIST__'); } catch (e) { /* dev / unreplaced */ }

const SHELL = 'rl-shell-' + BUILD;
const IMG = 'rl-img-v3'; // v3 guarantees all OpenLibrary, Apple, and Google covers are cached permanently
const API = 'rl-api-v1';
const FONT = 'rl-font-v1';
const KEEP = [SHELL, IMG, API, FONT];
// Covers are cross-origin, and Chromium counts each one it cannot read as several MB of storage quota, so keep this modest.
const LIMITS = { [IMG]: 400, [API]: 250, [FONT]: 40 };

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STAMP = 'x-sw-cached-at';
const MATCH = { ignoreVary: true };
const DICT_HOSTS = ['api.dictionaryapi.dev', 'en.wiktionary.org', 'en.wikipedia.org'];
const BOOK_HOSTS = ['openlibrary.org', 'www.googleapis.com', 'itunes.apple.com'];

// Hosts whose images don't allow CORS reads (learned at runtime or known CDNs).
const noCors = new Set([
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com',
  'is5-ssl.mzstatic.com',
  'books.google.com',
]);

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'GET_BUILD' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ build: BUILD });
  } else if (type === 'WARM_COVERS' && Array.isArray(event.data.urls)) {
    // The app tells us which covers it will show first; fetch the missing ones now so they are on the device next time.
    event.waitUntil(warmCovers(event.data.urls.filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 80)));
  }
});

async function warmCovers(urls) {
  const cache = await caches.open(IMG);
  const todo = [];
  for (const u of urls) if (!(await cache.match(u, MATCH))) todo.push(u);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const u = todo[next++];
      try { await coverImage(new Request(u, { mode: 'no-cors', credentials: 'omit' })); } catch (e) { /* offline or missing: skip */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const urls = ['/', '/manifest.json', '/exact-icon-192.png', '/exact-icon-512.png', '/exact-apple-touch-icon.png', '/exact-favicon.png'].concat(PRECACHE);
    await Promise.allSettled(urls.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range') || req.destination === 'audio' || req.destination === 'video') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return;

  // ---- same origin ----
  if (url.origin === self.location.origin) {
    if (url.pathname === '/sw.js' || url.pathname === '/version.json' || url.pathname.endsWith('.zip') || url.pathname.startsWith('/api/')) return; // always the network: these must never be stale
    if (req.mode === 'navigate') return event.respondWith(navigate(req));
    if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(req, SHELL));
    if (url.pathname === '/' || url.pathname.endsWith('.html')) return event.respondWith(networkFirst(req, SHELL, 4000));
    return event.respondWith(staleWhileRevalidate(event, req, SHELL));
  }

  // ---- other sites ----
  const host = url.hostname;
  if (req.destination === 'image') return event.respondWith(coverImage(req));
  if (host === 'fonts.googleapis.com') return event.respondWith(staleWhileRevalidate(event, req, FONT));
  if (host === 'fonts.gstatic.com') return event.respondWith(cacheFirst(req, FONT));
  // Wikipedia's API also feeds the Store's prize shelves (Oprah, Women's Prize, International Booker): those answers must stay fresh
  if (host === 'en.wikipedia.org' && url.pathname === '/w/api.php') return event.respondWith(ttlFetch(req, API, 12 * HOUR));
  if (DICT_HOSTS.includes(host)) return event.respondWith(ttlFetch(req, API, 30 * DAY));
  if (BOOK_HOSTS.includes(host)) return event.respondWith(ttlFetch(req, API, 12 * HOUR));
});

/* ---------------- strategies ---------------- */

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');

async function navigate(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res.ok && !res.redirected && isHtml(res)) cache.put('/', res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match('/', MATCH);
    if (hit) return hit;
    throw e;
  }
}

async function networkFirst(req, name, ms) {
  const cache = await caches.open(name);
  try {
    const res = await withTimeout(fetch(req), ms);
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, MATCH);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, MATCH);
  if (hit) return hit;
  const res = await fetch(req);
  // The SPA fallback answers missing files with index.html; never cache that as a script/style.
  if ((res.ok && !isHtml(res)) || res.type === 'opaque') {
    await cache.put(req, res.clone());
    trim(name);
  }
  return res;
}

async function staleWhileRevalidate(event, req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, MATCH);
  const update = fetch(req)
    .then((res) => {
      if ((res.ok && !isHtml(res)) || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || Response.error();
}

async function stamp(res) {
  const headers = new Headers(res.headers);
  headers.set(STAMP, String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

/** Fresh cache hit -> use it. Otherwise ask the network, and fall back to a stale copy when offline. */
async function ttlFetch(req, name, ttl) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, MATCH);
  const age = hit ? Date.now() - Number(hit.headers.get(STAMP) || 0) : Infinity;
  if (hit && age < ttl) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, await stamp(res.clone()));
      trim(name);
    }
    return res;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

/**
 * Covers: cache-first. We try a CORS request first so we can see the real status and never store a 404 as if it
 * were a cover; hosts that don't allow CORS (Apple/Google CDNs) fall back to the normal opaque request.
 */
async function coverImage(req) {
  const cache = await caches.open(IMG);
  const url = req.url;
  const hit = (await cache.match(url, MATCH)) || (await cache.match(req, MATCH));
  if (hit) return hit;

  const host = new URL(url).hostname;
  if (!noCors.has(host)) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) {
        await cache.put(url, res.clone());
        trim(IMG);
      }
      return res;
    } catch (e) {
      noCors.add(host);
    }
  }
  const res = await fetch(req);
  if (res.type === 'opaque' || res.ok) {
    await cache.put(url, res.clone());
    trim(IMG);
  }
  return res;
}

/** Keep each cache under its size limit (oldest entries go first). Runs on ~1 in 8 writes. */
async function trim(name) {
  const max = LIMITS[name];
  if (!max || Math.random() > 0.125) return;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
