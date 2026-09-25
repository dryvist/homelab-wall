// Keeps the most recent known-good value per key, in memory and mirrored to localStorage
// (best-effort: a private window or blocked storage must not break the page), so a metric that
// drops out of a single poll — or a page reload — does not lose the last value it had.
const NS = 'wall:lastGood:';
const mem = new Map();

function read(key) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, entry) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(entry));
  } catch {
    // private window, blocked storage, or quota — the in-memory copy still works for this load.
  }
}

// Records a fresh good `value` for `key`, timestamped now.
export function lastGoodSet(key, value) {
  const entry = { value, at: Date.now() };
  mem.set(key, entry);
  write(key, entry);
  return entry;
}

// Returns { value, at } for the latest good value ever seen for `key` (this page load or a
// prior one), or undefined if none has ever been recorded.
export function lastGoodGet(key) {
  if (mem.has(key)) return mem.get(key);
  const entry = read(key);
  if (entry) mem.set(key, entry);
  return entry;
}
