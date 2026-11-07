// These are signal roles, never identities discovered in metric labels.
export const NODES = [
  { id: 'gateway', label: 'Hermes gateway', signal: null, unit: 'events/s', x: .20, y: .27, color: '#f6c780' },
  { id: 'cron', label: 'Hermes cron', signal: null, unit: 'events/s', x: .12, y: .61, color: '#f6c780', parent: 'gateway' },
  { id: 'donna', label: 'Donna', signal: 'mc9DonnaRate', unit: 'requests/s', x: .47, y: .21, color: '#e8a9d5' },
  { id: 'memory', label: 'Hindsight memory', signal: 'mc9HindsightRate', unit: 'operations/s', x: .44, y: .66, color: '#9ddac9' },
  { id: 'codex', label: 'Codex', signal: 'mc9CodexRate', role: '', unit: 'output tokens/s', x: .73, y: .27, color: '#aebcff' },
  { id: 'codex-subagents', label: 'Codex subagents', signal: 'mc9CodexRate', role: 'subagents', unit: 'output tokens/s', x: .88, y: .12, color: '#aebcff', parent: 'codex' },
  { id: 'claude', label: 'Claude Code', signal: 'mc9ClaudeMainRate', unit: 'output tokens/s', x: .77, y: .67, color: '#ecb28e' },
  { id: 'claude-subagents', label: 'Claude subagents', signal: 'mc9ClaudeSubagentRate', unit: 'output tokens/s', x: .91, y: .48, color: '#ecb28e', parent: 'claude' },
  { id: 'spans', label: 'LLM spans', signal: 'mc9SpanRate', unit: 'spans/s', x: .56, y: .45, color: '#a7d7f0' },
];

export const STEP = 300;
export const WINDOW = 86400;
// The store rounds evaluation time up to a whole second and clocks drift, so allow a little future skew.
export const SKEW = 5;
const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const matching = (node, rows) => (rows || []).filter((r) => (r.labels?.backend || '') === (node.role || ''));

// Missing bins remain null: zero is reserved for an actual zero reading.
export function activityRing(points, now) {
  const end = Math.floor(now / STEP) * STEP;
  const bins = Array(288).fill(null);
  for (const [at, rate] of points) {
    if (!valid(at) || !valid(rate)) continue;
    if (at > now) continue;
    const index = (Math.floor(at / STEP) * STEP - (end - WINDOW + STEP)) / STEP;
    if (index >= 0 && index < bins.length) bins[index] = rate;
  }
  return bins;
}

// Deadlines bound polling even when the shared client's fetch never settles.
export async function withTimeout(request, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Metric request timed out')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export function refreshNode(node, now) {
  const ring = activityRing(node.points, now);
  return { ...node, ring,
    state: node.rate !== null && now - node.seenAt > STEP ? 'stale' : node.state,
    historyPending: ring.every((v) => v === null),
    // History refreshes every STEP: a missed refresh is stale, a series that has gone quiet is not.
    historyStale: node.historyFailed || (Number.isFinite(node.historyAt) && now - node.historyAt > 2 * STEP),
  };
}

const currentRows = (node, feed, now) => matching(node, feed?.current)
  .filter((r) => valid(r.value) && valid(r.timestamp) && r.timestamp <= now + SKEW)
  .map((r) => ({ ...r, timestamp: Math.min(r.timestamp, now) }));

export function shapeNodes(feeds, previous = [], now = Date.now() / 1000) {
  return NODES.map((node) => {
    const old = previous.find((n) => n.id === node.id);
    const feed = feeds[node.signal];
    let current = currentRows(node, feed, now);
    // A satellite's series exists only while it works. A successful poll without its row reads zero
    // while the parent reports, at the parent's sample time.
    const parent = NODES.find((n) => n.id === node.parent);
    if (!current.length && Array.isArray(feed?.current) && parent?.signal) {
      const lead = currentRows(parent, feeds[parent.signal], now);
      if (lead.length) current = [{ value: 0, timestamp: Math.min(...lead.map((r) => r.timestamp)) }];
    }
    const history = matching(node, feed?.history).flatMap((r) => r.values || [])
      .filter(([at, v]) => valid(at) && valid(v) && at <= now);
    const observed = current.length ? current.reduce((sum, r) => sum + r.value, 0) : null;
    const activeWindows = history.filter(([, v]) => v > 0).map(([at]) => at);
    const lastActive = Math.max(old?.lastActive || 0, ...activeWindows, ...current.filter((r) => r.value > 0).map((r) => r.timestamp)) || null;
    const seenAt = observed !== null ? Math.min(...current.map((r) => r.timestamp)) : old?.seenAt ?? null;
    const rate = observed ?? old?.rate ?? null;
    const points = feed?.history != null ? history : old?.points || [];
    const state = observed === null ? (rate === null ? 'pending' : 'stale')
      : now - seenAt > 300 ? 'stale' : observed > 0 ? 'active' : 'idle';
    return refreshNode({ ...node, rate, state, points, lastActive, seenAt,
      historyAt: feed?.history != null ? feed.historyAt : old?.historyAt,
      historyFailed: feed?.historyFailed === true }, now);
  });
}

export function ageLabel(at, now) {
  if (at == null) return 'not observed';
  const age = Math.max(0, Math.floor(now - at));
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  return `${Math.floor(age / 3600)}h ago`;
}
