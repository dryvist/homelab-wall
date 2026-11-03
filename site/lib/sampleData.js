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

// Stand-ins for mc1's topology overlays and firewall feeds: the VLAN rates while Q.vlanFwRate has
// no series, and the WAN and firewall rows, which have no live source wired up yet — a handful of
// plausible static rows shaped like the feed each one will eventually get, so the panel is never
// blank. Always marked with setSampleBadge/setStandIn (site/lib/stage.js); never merged into any
// page's own live model.

export const SAMPLE_VLANS = [
  { vlan: '10', rate: 4.2 },
  { vlan: '20', rate: 1.1 },
  { vlan: '30', rate: 0.4 },
];

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

// A deterministic per-node base that a node card's CPU/MEM/LOAD stand-in (mc1.js drawNodes)
// animates around while that node has no reading for the gauge. The GPU gauge has a real source
// (Q.acceleratorBusy) and never uses it.
export const sampleGpuBase = (i) => 18 + (i % 3) * 14;

