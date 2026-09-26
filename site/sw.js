// Service worker: keeps the kiosk shell — the running rotator, not just its HTML — bootable when
// the origin (auth proxy/backend) is down. Network-first for every shell asset: on a network
// error or 5xx, serve the precached copy instead of leaving a dead page with nothing running.
// Scope: site root.
const CACHE_NAME = 'wall-shell';
const MANIFEST_KEY = '/__sw_shell_manifest__'; // cache-internal keys, never fetched over the network
const VERSION_KEY = '/__sw_shell_version__';
// config.json isn't referenced in index.html's markup (rotator.js fetches it at runtime) so it
// can't be discovered by scanning the page; everything else is derived below.
const STATIC_SHELL_URLS = ['/', '/config.json'];

// The rotator's actual shell asset list, straight from the served index.html — every same-origin
// script/link it references — rather than a hand-maintained duplicate that silently drifts out of
// sync with the real page (a new asset the page starts loading would otherwise never get cached,
// and an outage would serve a shell that boots but can't run).
async function discoverShellUrls() {
  const html = await (await fetch('/', { cache: 'no-store' })).text();
  const urls = new Set(STATIC_SHELL_URLS);
  for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const u = new URL(m[1], self.location.origin);
      if (u.origin === self.location.origin) urls.add(u.pathname);
    } catch { /* not a URL (e.g. a data: href) — not a shell asset */ }
  }
  return { html, urls: [...urls] };
}

// A hash of index.html plus rotator.js's own bytes — changes on any release that touches either,
// with nothing to bump by hand. When it differs from what's stored, the whole shell is refetched
// and re-cached; otherwise the existing entries are left alone.
async function shellVersion(html) {
  const rotator = await (await fetch('/rotator/rotator.js', { cache: 'no-store' })).text();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html + '\u0000' + rotator));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const { html, urls } = await discoverShellUrls();
      const version = await shellVersion(html);
      const cache = await caches.open(CACHE_NAME);
      const stored = await cache.match(VERSION_KEY);
      if (!stored || (await stored.text()) !== version) {
        // A manual fetch+put loop, not cache.addAll(urls): addAll fetches internally and fails the
        // whole precache if any single asset's request doesn't come back exactly as it expects
        // (seen under Playwright's request interception in tests, status 200 and all) — one asset
        // failing here just leaves that entry as whatever was cached before, instead of aborting.
        await Promise.all(urls.map(async (u) => {
          try {
            const res = await fetch(u, { cache: 'no-store' });
            if (res.ok) await cache.put(u, res);
          } catch { /* unreachable right now — leave any previously-cached copy in place */ }
        }));
        await cache.put(VERSION_KEY, new Response(version));
      }
      // The manifest is written every install (even when the version is unchanged) so the fetch
      // handler always has a list, and so it stays correct if urls' derivation ever changes without
      // the hashed content changing.
      await cache.put(MANIFEST_KEY, new Response(JSON.stringify(urls)));
    } catch {
      // Origin unreachable at install time — nothing to precache yet; a later install (once the
      // origin recovers and re-registers) will populate it.
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function shellUrls() {
  const cache = await caches.open(CACHE_NAME);
  const stored = await cache.match(MANIFEST_KEY);
  return stored ? await stored.json() : STATIC_SHELL_URLS;
}

// Network-first for a shell asset: on a network error or 5xx, serve the cached copy so the shell
// (and everything it needs to actually run, not just render its HTML) stays available through an
// outage; on a 200, refresh the cache so the next outage falls back to the latest good copy.
async function networkFirstShellAsset(request, pathname) {
  try {
    const res = await fetch(request, { cache: 'no-store' });
    if (res.status >= 500) throw new Error(`origin ${res.status}`);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(pathname, res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(pathname)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const pathname = new URL(request.url).pathname;
  // Slide iframes navigate too (same origin, mode 'navigate') — only the wall root's own shell is
  // handled here; a slide's navigation passes through untouched exactly as before.
  if (request.mode === 'navigate' && pathname !== '/') return;
  event.respondWith((async () => {
    const urls = await shellUrls();
    if (!urls.includes(pathname)) return fetch(request); // not a shell asset — normal passthrough
    return networkFirstShellAsset(request, pathname);
  })());
});
