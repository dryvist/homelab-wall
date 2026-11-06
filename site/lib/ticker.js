import { onDispose } from './stage.js';

const POLL_MS = 60_000;
const STALE_MS = 2 * POLL_MS;
const age = (ms) => ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`;

// ClickHouse's timezone-less DateTime values are UTC; ISO timestamps keep their offset.
function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const iso = value.replace(' ', 'T');
  return Date.parse(/[Zz]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
}

export function mountTicker(root) {
  const controller = new AbortController();
  let rows = [], failed = false, paused = false;
  root.classList.add('llm-ticker');
  root.setAttribute('aria-label', 'Recent LLM activity, metadata only');
  const label = document.createElement('strong');
  label.textContent = 'LLM ACTIVITY';
  const status = document.createElement('span');
  status.className = 'ticker-status';
  const viewport = document.createElement('div');
  viewport.className = 'ticker-viewport';
  const track = document.createElement('div');
  track.className = 'ticker-track';
  viewport.append(track);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Pause';
  button.setAttribute('aria-label', 'Pause activity ribbon');
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    paused = !paused;
    root.classList.toggle('ticker-paused', paused);
    button.textContent = paused ? 'Resume' : 'Pause';
    button.setAttribute('aria-label', `${paused ? 'Resume' : 'Pause'} activity ribbon`);
    button.setAttribute('aria-pressed', String(paused));
  }, { signal: controller.signal });
  root.replaceChildren(label, status, viewport, button);

  function updateAge() {
    const now = Date.now();
    const elapsed = rows.length ? Math.max(0, now - rows[0].at) : 0;
    const stale = rows.length && (failed || elapsed >= STALE_MS);
    root.dataset.state = !rows.length ? 'pending' : stale ? 'stale' : 'ok';
    status.textContent = !rows.length ? 'pending' : stale
      ? elapsed < 300_000 ? `STALE ${age(elapsed)}` : `STALE since ${new Date(rows[0].at).toISOString()}`
      : 'RECENT';
    button.hidden = !rows.length;
    for (const el of track.querySelectorAll('time')) {
      el.textContent = `${age(Math.max(0, now - Date.parse(el.dateTime)))} ago`;
    }
  }

  function render() {
    const items = document.createElement('div');
    items.className = 'ticker-items';
    items.setAttribute('role', 'list');
    for (const row of rows) {
      const entry = document.createElement('span');
      entry.className = 'ticker-entry';
      entry.setAttribute('role', 'listitem');
      // Explicit allow-list: never copy message content or unknown feed fields into the DOM.
      for (const text of [row.source, row.model, row.role, `${row.chars} chars`]) {
        const field = document.createElement('span');
        field.textContent = text;
        entry.append(field);
      }
      const time = document.createElement('time');
      time.dateTime = new Date(row.at).toISOString();
      entry.append(time);
      items.append(entry);
    }
    const repeat = items.cloneNode(true);
    repeat.setAttribute('aria-hidden', 'true');
    track.replaceChildren(items, repeat);
    updateAge();
  }

  async function refresh() {
    try {
      const res = await fetch('/api/llm/recent', {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!res.ok) throw new Error('Recent activity unavailable');
      const body = await res.json();
      const data = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(data)) throw new Error('Invalid activity feed');
      const next = data.map((row) => {
        if (!row || typeof row !== 'object') return null;
        const at = timestamp(row.ts);
        const chars = typeof row.chars === 'string' && /^\d+$/.test(row.chars) ? Number(row.chars) : row.chars;
        if (!Number.isFinite(at) || at > Date.now() || !Number.isSafeInteger(chars) || chars < 0 ||
            !['source', 'model', 'role'].every((key) => typeof row[key] === 'string' && row[key].trim())) return null;
        return { at, chars, source: row.source, model: row.model, role: row.role };
      }).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 24);
      if (data.length && !next.length) throw new Error('Invalid activity rows');
      if (controller.signal.aborted) return;
      rows = next;
      failed = false;
      render();
    } catch {
      if (controller.signal.aborted) return;
      failed = true;
      updateAge();
    }
  }

  updateAge();
  void refresh();
  const poll = setInterval(refresh, POLL_MS);
  const clock = setInterval(updateAge, 10_000);
  return onDispose(() => {
    controller.abort();
    clearInterval(poll);
    clearInterval(clock);
  });
}
