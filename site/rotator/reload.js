const RELOAD_OVERRIDE_MS = Number(new URLSearchParams(location.search).get('reloadms')) || 0;

const RELOAD_RETRY_MS = 60 * 1000;

// Confirms the origin is actually serving the site before navigating away from the running
// rotation — a `location.reload()` fired while the auth proxy/backend is down gets Brave's own
// error page with no wall JS left running and nothing to retry (Track: self-heal). A network
// error, a non-200, or an opaque redirect all count as "not ready"; the current rotation just
// keeps going and this re-checks every RELOAD_RETRY_MS until the origin recovers.
async function originReady() {
  try {
    const res = await fetch(location.href, { cache: 'no-store', credentials: 'include', redirect: 'manual' });
    if (res.type === 'opaqueredirect' || res.status !== 200) return false;
    const html = await res.text();
    return html.includes('/rotator/rotator.js'); // the rotator's own script tag
  } catch {
    return false;
  }
}

async function attemptReload() {
  if (await originReady()) location.reload();
  else setTimeout(attemptReload, RELOAD_RETRY_MS);
}

// Reloads the whole page every `reloadMinutes` so a new deployed release shows up on the kiosk
// without anyone touching it — a fresh document pulls in whatever build is currently live.
export function scheduleReload(reloadMinutes) {
  setTimeout(attemptReload, RELOAD_OVERRIDE_MS || reloadMinutes * 60 * 1000);
}

// A service worker keeps the kiosk shell bootable across an outage even without this rotator
// running (e.g. after a manual reload lands mid-outage): see site/sw.js.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
