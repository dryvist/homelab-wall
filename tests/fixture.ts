// Fake data only — never captured from a real system.
import type { Page, Route } from '@playwright/test';
import { sampleAppScore } from '../site/lib/sampleData.js';

export const config = {
  title: 'HOMELAB',
  refreshSeconds: 15,
  guestCount: 42,
  // node-c: role equals the node's own name (D2, ansible-side defect) — the page must omit
  // the subtitle rather than echo the name back at itself.
  nodeRoles: { 'node-a': 'compute', 'node-b': 'storage', 'node-c': 'node-c' },
  extraNodes: [{ name: 'studio', role: 'inference · not PVE' }],
  groups: [
    { name: 'apps', apps: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] },
    { name: 'media', apps: ['foxtrot', 'golf', 'hotel'] },
    { name: 'observ', apps: ['india', 'juliet'] },
    { name: 'ai', apps: ['kilo', 'lima', 'mike'] },
  ],
};

// mc5: fixture shape for the public GitHub API (site/mc5/mc5.js fetches api.github.com directly,
// no token) — routed below so CI never hits the real network. Event/repo/release fields are only
// the subset mc5.js reads.
export const GH_ORG = 'dryvist';
export const ghEvents = [
  { id: 'e1', type: 'PushEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/wall-repo` }, payload: { commits: [{}, {}] }, created_at: new Date(Date.now() - 30_000).toISOString() },
  { id: 'e2', type: 'PullRequestEvent', actor: { login: 'hubot' }, repo: { name: `${GH_ORG}/proxmox-repo` }, payload: { action: 'opened', pull_request: { merged: false } }, created_at: new Date(Date.now() - 90_000).toISOString() },
  { id: 'e3', type: 'PullRequestEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/ansible-repo` }, payload: { action: 'closed', pull_request: { merged: true } }, created_at: new Date(Date.now() - 200_000).toISOString() },
  { id: 'e4', type: 'ReleaseEvent', actor: { login: 'hubot' }, repo: { name: `${GH_ORG}/wall-repo` }, payload: {}, created_at: new Date(Date.now() - 400_000).toISOString() },
  { id: 'e5', type: 'DeploymentStatusEvent', actor: { login: 'octocat' }, repo: { name: `${GH_ORG}/nix-repo` }, payload: {}, created_at: new Date(Date.now() - 500_000).toISOString() },
];
export const ghRepos = ['wall-repo', 'proxmox-repo', 'ansible-repo', 'nix-repo', 'cribl-repo', 'docs-repo'].map((name, i) => ({
  name, private: false, pushed_at: new Date(Date.now() - i * 86400_000).toISOString(),
}));

export async function mockGithub(page: Page) {
  await page.route('https://api.github.com/orgs/*/events', (r: Route) => r.fulfill({ json: ghEvents, headers: { etag: '"fixture-events"' } }));
  await page.route('https://api.github.com/orgs/*/repos**', (r: Route) => r.fulfill({ json: ghRepos, headers: { etag: '"fixture-repos"' } }));
  await page.route('https://api.github.com/repos/*/*/releases**', (r: Route) => r.fulfill({
    json: [{ tag_name: 'v1.0.0', published_at: new Date(Date.now() - 3600_000).toISOString() }],
  }));
}

// mc6: fixture rows for /api/words (site/mc6/mc6.js fetches it directly, ClickHouse FORMAT
// JSON: n is a UInt64 serialized as a STRING). Sources with no rows here —
// antigravity and opencode — must render explicit NO FEED tiles, never stand-in words. The
// 'minion' row is deliberately from a source mc6 has never heard of: unknown sources are
// handled generically, same tile treatment, label upper-cased.
export const words = [
  { source: 'user', word: 'deploy', n: '412' },
  { source: 'user', word: 'backup', n: '187' },
  { source: 'user', word: 'certificate', n: '55' },
  { source: 'claude', word: 'refactor', n: '301' },
  { source: 'claude', word: 'fixture', n: '96' },
  { source: 'claude', word: 'typescript', n: '41' },
  { source: 'codex', word: 'benchmark', n: '77' },
  { source: 'codex', word: 'cache', n: '12' },
  // 'deploy' is held by the operator and codex: a word shared between a prompt source and an agent.
  { source: 'codex', word: 'deploy', n: '33' },
  { source: 'zcode', word: 'prometheus', n: '64' },
  { source: 'zcode', word: 'playwright', n: '29' },
  { source: 'minion', word: 'banana', n: '9' },
];

// opts.failWords turns the words feed into a hard failure (HTTP 500) instead of answering it;
// opts.emptyWords makes it succeed with zero rows — genuinely "no words yet".
export async function mockWords(page: Page, opts: { failWords?: boolean; emptyWords?: boolean } = {}) {
  await page.route('**/api/words', (r: Route) => {
    if (opts.failWords) return r.fulfill({ status: 500, json: { error: 'forced failure' } });
    const data = opts.emptyWords ? [] : words;
    return r.fulfill({ json: { meta: [{ name: 'source', type: 'String' }, { name: 'word', type: 'String' }, { name: 'n', type: 'UInt64' }], data, rows: data.length } });
  });
}

const NODES = ['node-a', 'node-b', 'node-c'];
const inst = (n: string) => ({ instance: `${n}.example.test:9100`, job: 'pve_node_exporter' });
const vec = (rows: Array<[Record<string, string>, number]>) =>
  rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));

// Exported so tests/snapshot.spec.ts can build a snapshot.json fixture from the same answers
// instead of a second hand-maintained copy of every query's expected shape.
export function answer(q: string): unknown[] {
  if (q.includes('gatus_results_total') && q.includes('by (name)')) {
    const rows = config.groups.flatMap((g) => g.apps).map((n, i): [Record<string, string>, number] => [{ name: n }, sampleAppScore(i)]);
    // D5 (ansible-side defect): 'juliet' has no Gatus series at all — must count as "no data", not a score.
    return vec(rows.filter(([metric]) => metric.name !== 'juliet'));
  }
  if (q.includes('gatus_results_total')) return vec([[{}, 99.93]]);
  if (q.includes('mode="idle"') && q.startsWith('count')) return vec(NODES.map((n, i) => [inst(n), [48, 24, 32][i]]));
  if (q.includes('mode="idle"')) return vec(NODES.map((n, i) => [inst(n), [34, 18, 52][i]]));
  if (q.includes('MemAvailable')) return vec(NODES.map((n, i) => [inst(n), [61, 72, 48][i]]));
  if (q.includes('MemTotal')) return vec(NODES.map((n, i) => [inst(n), [384, 144, 128][i] * 1e9]));
  if (q.includes('node_load1')) return vec(NODES.map((n, i) => [inst(n), [9.4, 3.1, 14.2][i]]));
  if (q.includes('hwmon')) return vec(NODES.map((n, i) => [inst(n), [44, 57, 60][i]]));
  if (q.includes('boot_time')) return vec(NODES.map((n, i) => [inst(n), (i + 1) * 20 * 86400]));
  // Two accelerators: mc1's GPU gauges must show the busier one (64), never the other or a blend;
  // mc3's GPU tile shows their mean (36/64 -> 50%).
  if (q.includes('accelerator:busy_percent')) return vec([[{ accelerator: 'accel-0' }, 36], [{ accelerator: 'accel-1' }, 64]]);
  // D3: a shared NFS mount — same device + mountpoint reported by two nodes — must be shown
  // once, not once per node, and must not double-count in the RAW total.
  const SHARED_DEVICE = { device: 'nas:/export/shared', mountpoint: '/mnt/pve/shared-nfs', fstype: 'nfs4' };
  if (q.includes('filesystem_size')) {
    return vec([
      ...NODES.flatMap((n, i) => [[{ ...inst(n), device: `pool${i}`, mountpoint: '/' }, (i + 2) * 4e12], [{ ...inst(n), device: `data${i}`, mountpoint: '/data' }, (i + 1) * 16e12]]),
      [{ ...inst('node-a'), ...SHARED_DEVICE }, 8e12],
      [{ ...inst('node-b'), ...SHARED_DEVICE }, 8e12],
    ] as Array<[Record<string, string>, number]>);
  }
  if (q.includes('filesystem_avail')) {
    return vec([
      ...NODES.flatMap((n, i) => [[{ ...inst(n), device: `pool${i}`, mountpoint: '/' }, (i + 2) * 1.5e12], [{ ...inst(n), device: `data${i}`, mountpoint: '/data' }, (i + 1) * 3e12]]),
      [{ ...inst('node-a'), ...SHARED_DEVICE }, 3e12],
      [{ ...inst('node-b'), ...SHARED_DEVICE }, 3e12],
    ] as Array<[Record<string, string>, number]>);
  }
  if (q.includes('unifi_vlan_fw_events_total')) return vec([[{ vlan: '10' }, 4.2], [{ vlan: '20' }, 1.1], [{ vlan: '30' }, 0.4]]);
  if (q.includes('litellm_deployment_state')) return vec([[{ litellm_model_name: 'model-large' }, 0], [{ litellm_model_name: 'model-coder' }, 0], [{ litellm_model_name: 'model-small' }, 2], [{ litellm_model_name: 'model-mini' }, 0]]);
  if (q.includes('litellm_output_tokens')) return vec([[{ model: 'model-large' }, 38], [{ model: 'model-coder' }, 91]]);
  // mc3
  if (q.includes('litellm_total_tokens_metric_total')) return vec([[{}, 4_810_000]]);
  if (q.includes('litellm_proxy_total_requests_metric_total')) return vec([[{}, 142]]);
  // model-coder deliberately has no row here: no requests in the window is a real, idle model,
  // not a failed query — proves mc3 renders that as a quiet "idle" state, never a placeholder.
  if (q.includes('litellm_request_queue_time_seconds_sum')) return vec([[{ model: 'model-large' }, 4.5]]);
  // model-mini: a >60s average (the reported bug's own "avg 203361ms") — proves the minutes range.
  if (q.includes('litellm_llm_api_latency_metric_sum')) return vec([[{ model: 'model-large' }, 0.842], [{ model: 'model-mini' }, 203.361]]);
  return [];
}

// opts.failQuery marks a query as a hard failure (HTTP 500) instead of answering it — for
// proving a failed query renders an explicit error, never a silent zero/empty result.
// opts.emptyQuery forces a query to succeed with zero rows instead — genuinely "no data yet",
// distinct from a failure, for proving the panel falls back to sample data (site/lib/sampleData.js).
export async function mockFeeds(page: Page, opts: { failQuery?: (q: string) => boolean; emptyQuery?: (q: string) => boolean; recent?: unknown[] | ((n: number) => unknown[]); failWords?: boolean; emptyWords?: boolean } = {}) {
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: config }));
  await mockGithub(page);
  await mockWords(page, opts);
  await page.route('**/api/prom/**', (r: Route) => {
    const url = new URL(r.request().url());
    const q = url.searchParams.get('query') || '';
    if (opts.failQuery?.(q)) return r.fulfill({ status: 500, json: { status: 'error', error: 'forced failure' } });
    const rows = opts.emptyQuery?.(q) ? [] : answer(q);
    const result = url.pathname.endsWith('query_range')
      ? rows.map((x: any) => ({ metric: x.metric, values: Array.from({ length: 60 }, (_, k) => [k, String(20 + ((k * 7) % 50))]) }))
      : rows;
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result } } });
  });
  await mockRecent(page, opts);
}

// mc3's request feed (GET /api/llm/recent — metadata rows only, never message content). Tests
// pass their own rows through opts.recent, or opts.failQuery to get mc3's explicit NO FEED
// state. fake data only.
export const recentRows = [
  { ts: '2026-01-01 00:00:09', source: 'user', model: 'model-large', role: 'user', chars: 120 },
  { ts: '2026-01-01 00:00:08', source: 'claude', model: 'model-coder', role: 'assistant', chars: 2480 },
  { ts: '2026-01-01 00:00:07', source: 'zcode', model: 'model-large', role: 'assistant', chars: 311 },
];

export async function mockRecent(page: Page, opts: { failQuery?: (q: string) => boolean; recent?: unknown[] | ((n: number) => unknown[]) } = {}) {
  await page.route('**/api/llm/recent*', (r: Route) => {
    if (opts.failQuery?.('/api/llm/recent')) return r.fulfill({ status: 404, body: 'no feed' });
    const rows = typeof opts.recent === 'function' ? opts.recent(recentRows.length) : opts.recent ?? recentRows;
    return r.fulfill({ json: rows });
  });
  // Any other /api/ route stays unwired on the fixture: pages must treat a 404 as an explicit
  // no-feed state, never fabricated values. /api/words falls through to mockWords.
  await page.route('**/api/**', (r: Route) => {
    const url = r.request().url();
    if (['/api/prom/', '/api/llm/recent', '/api/words', 'config.json'].some((p) => url.includes(p))) return r.fallback();
    return r.fulfill({ status: 404, body: 'no feed' });
  });
}
