import { esc } from '/lib/stage.js';
const $ = (id) => document.getElementById(id);
export const FEED_POLL_MS = 5000;
export function recentFeed(getCore) {
/* ---------------- request feed: GET /api/llm/recent ---------------- */
// Metadata rows only ({ts, source, model, role, chars}; never message content), newest first.
// Each row not seen on the previous poll launches a comet from its core to the hub. A failed or
// malformed response clears the feed to an explicit NO FEED state — never invented rows.
const FEED_ROWS = 24;
let feedSeen = null;
const rowKey = (r) => `${r.ts}|${r.source}|${r.model}|${r.role}|${r.chars}`;
const fmtChars = (n) => (n < 1000 ? `${n} ch` : `${(n / 1000).toFixed(1)}k ch`);
function feedNotice(state, text) {
  const feed = $('reqfeed');
  feed.dataset.feed = state;
  feed.innerHTML = `<div class="cfrow cfnote">${text}</div>`;
  feedSeen = state === 'none' ? null : new Set();
}
async function pollFeed() {
  let rows;
  try {
    const res = await fetch('/api/llm/recent', { cache: 'no-store' });
    if (!res.ok) throw new Error(`recent ${res.status}`);
    const body = await res.json();
    rows = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(rows)) throw new Error('recent: unexpected body');
  } catch (e) {
    console.warn('llm recent', e);
    feedNotice('none', 'NO FEED');
    return;
  }
  rows = rows.filter((r) => r && typeof r === 'object').sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (!rows.length) { feedNotice('empty', 'NO RECENT REQUESTS'); return; }
  const primed = feedSeen != null;
  const fresh = rows.filter((r) => !feedSeen?.has(rowKey(r)));
  // First load: only the newest few launch comets, staggered, rather than the whole backlog.
  const launch = primed ? fresh : fresh.slice(0, 6);
  launch.slice().reverse().forEach((r, i) => getCore()?.comet(r, i * Math.min(600, FEED_POLL_MS / launch.length)));
  const freshKeys = new Set(fresh.map(rowKey));
  const feed = $('reqfeed');
  feed.dataset.feed = 'live';
  feed.innerHTML = rows.slice(0, FEED_ROWS).map((r) => {
    const chars = Math.max(0, Math.round(Number(r.chars) || 0));
    const who = [r.source, String(r.model ?? '').split('/').pop()].filter(Boolean).map(esc).join(' · ');
    return `<div class="cfrow${primed && freshKeys.has(rowKey(r)) ? ' cfrow-in' : ''}"><span>${who}</span><b>${esc(r.role)}</b><b>${fmtChars(chars)}</b></div>`;
  }).join('');
  feedSeen = new Set(rows.map(rowKey));
}

return pollFeed;
}
