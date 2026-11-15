/**
 * sw.js — Application Shell Service Worker
 * Version: bump CACHE_VERSION when deploying a new index.html
 *
 * Strategy: Cache-first for the app shell (index.html + telegram-web-app.js),
 *           network-only for every API / auth / Supabase request.
 *
 * NEVER cached: initData, auth responses, chat messages, user profiles,
 *               Supabase function calls, signed URLs, or anything with
 *               credentials.
 */

'use strict';

// ─── Version ────────────────────────────────────────────────────────────────
// Increment this string on every new deployment to bust the old cache.
const CACHE_VERSION = 'v1';
const CACHE_NAME    = `app-shell-${CACHE_VERSION}`;

// ─── Resources to pre-cache on install ──────────────────────────────────────
// Only safe, versioned, same-origin static assets go here.
// The Telegram SDK is cross-origin but publicly cacheable and has no credentials.
const PRECACHE_URLS = [
  '/',            // the index.html served at the root
  '/index.html',  // explicit path as well
];

// External resources that are safe to cache (cache-first after first fetch).
const EXTERNAL_CACHEABLE = [
  'https://telegram.org/js/telegram-web-app.js',
];

// ─── Patterns that must NEVER be cached ─────────────────────────────────────
const NEVER_CACHE_PATTERNS = [
  // Supabase Edge Functions (API + auth)
  /\/functions\/v1\//,
  // Supabase Storage (signed upload/download URLs contain tokens)
  /supabase\.co\/storage\//,
  /supabase\.co\/rest\//,
  // Any URL that carries auth tokens or initData in query/path
  /[?&](token|key|apikey|initData|hash|auth)=/i,
  // Supabase realtime
  /supabase\.co\/realtime\//,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shouldNeverCache(url) {
  return NEVER_CACHE_PATTERNS.some(p => p.test(url));
}

function isExternalCacheable(url) {
  return EXTERNAL_CACHEABLE.some(u => url.startsWith(u));
}

function isSameOriginNavigation(request) {
  return request.mode === 'navigate';
}

// ─── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache same-origin shell URLs.
      // Use {cache: 'reload'} so we bypass any HTTP cache and store a fresh copy.
      const shellFetches = PRECACHE_URLS.map(url =>
        fetch(url, { cache: 'reload' })
          .then(response => {
            if (response.ok) return cache.put(url, response);
          })
          .catch(() => { /* non-fatal: SW still installs */ })
      );

      // Cache the external Telegram SDK.
      const externalFetches = EXTERNAL_CACHEABLE.map(url =>
        fetch(url, { cache: 'reload' })
          .then(response => {
            if (response.ok) return cache.put(url, response);
          })
          .catch(() => {})
      );

      return Promise.all([...shellFetches, ...externalFetches]);
    }).then(() => self.skipWaiting())   // activate immediately, don't wait for old SW to die
  );
});

// ─── Activate: delete obsolete cache versions ────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('app-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())  // take control of all open pages immediately
  );
});

// ─── Fetch: route each request ───────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // 1. Never intercept non-GET requests (POST, PUT, etc. — all API traffic).
  if (request.method !== 'GET') return;

  // 2. Never cache private/dynamic endpoints.
  if (shouldNeverCache(url)) return;

  // 3. Navigation requests: serve cached shell, fall back to network.
  //    This is the key win: the shell loads instantly from cache on second launch.
  if (isSameOriginNavigation(request)) {
    event.respondWith(
      caches.match('/index.html').then(cached => {
        if (cached) {
          // Return the cached shell immediately, then update in background.
          updateCacheInBackground('/index.html', url);
          return cached;
        }
        // First visit or cache cleared — fetch from network.
        return fetchAndCache(request, CACHE_NAME);
      })
    );
    return;
  }

  // 4. Same-origin static assets (JS, CSS, images if any are added later).
  const isSameOrigin = url.startsWith(self.location.origin);
  if (isSameOrigin && !shouldNeverCache(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. The Telegram SDK and other explicitly allowed external resources.
  if (isExternalCacheable(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // All other requests (cross-origin, Supabase, etc.) — let the browser handle them.
});

// ─── Cache strategies ─────────────────────────────────────────────────────────

/** Cache-first: return from cache if available, otherwise fetch and cache. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetchAndCache(request, CACHE_NAME);
}

/** Fetch from network and store a copy in cache. */
async function fetchAndCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network unavailable — if we have a cached copy, return it as a fallback.
    const fallback = await caches.match(request);
    if (fallback) return fallback;
    throw err;
  }
}

/** Stale-while-revalidate: update the cache in the background without blocking. */
function updateCacheInBackground(cacheKey, fetchUrl) {
  fetch(fetchUrl, { cache: 'no-cache' })
    .then(response => {
      if (response.ok) {
        return caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, response));
      }
    })
    .catch(() => { /* network unavailable — keep the stale cached version */ });
}