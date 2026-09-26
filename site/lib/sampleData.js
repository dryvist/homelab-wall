// Sample data for a panel whose real query has no data yet — reused by tests/fixture.ts (the
// mocked Prometheus response) AND by a page's own "no live data yet" panel fallback, so the
// sample content lives in exactly one place instead of drifting between test and production.

// Deterministic per-position score (the new 0-9 scale; see APP_HEALTH_SCORE, site/lib/queries.js)
// for an app with no live score yet. Position-based, not per-name, so both call sites (the
// fixture's index into config.groups.flatMap, a page's own index into its cfg.groups.flatMap)
// can reuse it against whatever real app names are actually configured. The same three-tier
// spread (one DOWN, one DEGRADED, the rest OK) the fixture always exercised.
export const sampleAppScore = (i) => (i === 3 ? 2 : i === 6 ? 6 : 8 + (i % 2));

// Storage and LLM panels have no real-name analogue when their query returns nothing at all —
// their row identities come entirely from Prometheus labels, never from config.json — so a
// fixed, clearly-fake dataset stands in instead.
export const SAMPLE_STORAGE = [
  { host: 'node-a', name: 'rpool', size: 4e12, used: 1.5e12 },
  { host: 'node-b', name: 'data0', size: 16e12, used: 8e12 },
  { host: 'shared', name: 'shared', size: 8e12, used: 5e12 },
];

export const SAMPLE_LLM = [
  { n: 'model-large', state: 0, tok: 38, hist: Array(30).fill(38) },
  { n: 'model-coder', state: 0, tok: 91, hist: Array(30).fill(91) },
  { n: 'model-small', state: 2, tok: 0, hist: Array(30).fill(0) },
];

// The panels below have no live source wired up at all yet (mc1 topology/firewall, mc2 threat,
// mc4 acquisition/pipeline, mc5 github/infra/activity) — a handful of plausible static rows,
// shaped like the feed each one will eventually get, replace their single "pending" line so the
// panel is never blank. Always shown behind setSampleBadge (site/lib/stage.js); never merged
// into any page's own live model.

export const SAMPLE_WAN = [
  { name: 'WAN1', down: 92, up: 11, latency: 14 },
  { name: 'WAN2', down: 48, up: 6, latency: 22 },
];

export const SAMPLE_BLOCKED = [
  { time: '14:02:31', flag: '🌐', country: 'unknown', source: 'edge-scanner', reason: 'port scan', ago: '2s' },
  { time: '14:01:58', flag: '🌐', country: 'unknown', source: 'botnet-node', reason: 'bad auth', ago: '35s' },
  { time: '13:59:04', flag: '🌐', country: 'unknown', source: 'crawler', reason: 'rate limit', ago: '3m' },
];

export const SAMPLE_ALLOWED = [
  { time: '14:03:10', action: 'allow', proto: 'TCP', desc: 'HTTPS inbound', dest: 'ingress', ago: '0s' },
  { time: '14:03:05', action: 'allow', proto: 'TCP', desc: 'SSH mgmt', dest: 'bastion', ago: '5s' },
  { time: '14:02:50', action: 'drop', proto: 'UDP', desc: 'unsolicited', dest: 'edge', ago: '20s' },
];

export const SAMPLE_THREAT_STATS = { blockedToday: 482, uniqueSources: 137 };

export const SAMPLE_ACQ_CARDS = [
  { title: 'QBITTORRENT', note: '3 active · 42 MB/s down' },
  { title: 'VPN TUNNEL', note: 'connected · 8ms' },
];

export const SAMPLE_LIBRARY_CARDS = [
  { title: 'PLEX', note: '2 streams · 1 transcoding' },
  { title: 'ARR STACK', note: '5 queued imports' },
  { title: 'LIBRARY STORAGE', note: '38.2 / 60 TB' },
];

export const SAMPLE_GITHUB_ROWS = [
  { repo: 'homelab-wall', status: 'CI passing', ago: '4m' },
  { repo: 'ansible-proxmox-apps', status: 'PR open', ago: '22m' },
];

export const SAMPLE_INFRA_ROWS = [
  { name: 'Terrakube plan', status: 'queued', ago: '1m' },
  { name: 'Semaphore run', status: 'running', ago: '3m' },
];

export const SAMPLE_ACTIVITY_ROWS = [
  { text: 'develop merged to main', ago: '6m' },
  { text: 'release published', ago: '18m' },
];
