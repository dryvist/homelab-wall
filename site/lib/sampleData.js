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
