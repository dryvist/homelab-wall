// Service worker: keeps the kiosk shell bootable when the origin (auth proxy/backend) is down.
// Network-first for navigations — on a network error or 5xx, serve the precached shell instead of
// leaving the browser's own error page on screen with nothing left running. Scope: site root.
const CACHE_NAME = 'wall-shell';
const SHELL_URLS = ['/', '/rotator/rotator.js', '/config.json'];
const VERSION_URL = '/__sw_shell_version__'; // cache-internal key only, never fetched over the network

// The cache "version" is a hash of rotator.js's own bytes — it changes on every release that
// touches the rotator, with nothing to bump by hand. When it differs from what's stored, the
// whole shell is refetched and re-cached; otherwise the existing entries are left alone.
async function currentShellVersion() {
  const res = await fetch('/rotator/rotator.js', { cache: 'no-store' });
  const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const version = await currentShellVersion();
      const cache = await caches.open(CACHE_NAME);
      const stored = await cache.match(VERSION_URL);
      if (!stored || (await stored.text()) !== version) {
        await cache.addAll(SHELL_URLS);
        await cache.put(VERSION_URL, new Response(version));
      }
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

async function networkFirstShell(request) {
  try {
    const res = await fetch(request);
    if (res.status >= 500) throw new Error(`origin ${res.status}`);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put('/', res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match('/')) || Response.error();
  }
}

async function networkFirstConfig(request) {
  try {
    const res = await fetch(request, { cache: 'no-store' });
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const pathname = new URL(request.url).pathname;
  // Slide iframes navigate too (same origin, mode 'navigate') — only the wall root itself is the
  // "shell" this worker keeps bootable; every other navigation (a slide) passes through untouched.
  if (request.mode === 'navigate' && pathname === '/') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (pathname === '/config.json') {
    event.respondWith(networkFirstConfig(request));
  }
  // everything else (slide iframes, vendor assets, fonts) passes through untouched
});
