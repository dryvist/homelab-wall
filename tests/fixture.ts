import type { Page, Route } from '@playwright/test';
import { Q } from '../site/lib/queries.js';

// A fixed per-position score spread: one DOWN, one DEGRADED, the rest OK.
export const sampleAppScore = (i: number) => (i === 3 ? 2 : i === 6 ? 6 : 8 + (i % 2));

export const config = {
  title: 'HOMELAB',
  refreshSeconds: 15,
  guestCount: 42,
  nodeRoles: { 'node-a': 'compute', 'node-b': 'storage', 'node-c': 'node-c' },
  extraNodes: [{ name: 'node-d', role: 'extra' }],
  groups: [
    { name: 'apps', apps: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] },
    { name: 'media', apps: ['foxtrot', 'golf', 'hotel', 'autobrr'] },
    { name: 'observ', apps: ['india', 'juliet'] },
    { name: 'ai', apps: ['kilo', 'lima', 'mike'] },
  ],
};

export { GH_ORG, ghEvents, ghRepos, words, mockGithub, mockWords } from './catalog-fixture';
import { mockGithub, mockWords } from './catalog-fixture';

const NODES = ['node-a', 'node-b', 'node-c'];
const inst = (n: string) => ({ instance: `${n}:9100`, job: 'pve_node_exporter' });
const vec = (rows: Array<[Record<string, string>, number]>) =>
  rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));
export const fixturePools = NODES.map((node, i) => {
  const suffix = String.fromCharCode(97 + i);
  return { node, name: `pool-${suffix}`, device: `pool-${suffix}/ROOT/base`, size: (i + 2) * 4e12,
    available: (i + 2) * 1.5e12, pveUsed: (i + 1) * 2.5e12 };
});
export const fixtureVlans = [
  { network: 'net-a', vlan: '10', rx: 1e6, tx: 0.5e6 },
  { network: 'net-b', vlan: '20', rx: 2e6, tx: 1e6 },
  { network: 'net-c', vlan: '30', rx: 3e6, tx: 1.5e6 },
  { network: 'net-d', vlan: '40', rx: 4e6, tx: 2e6 },
];

export interface AnswerOpts {
  inflight?: number;
  vllmRunning?: number;
  llamaRunning?: number;
  extraLocal?: Array<[string, number]>;
  extraApiBase?: Array<Record<string, string>>;
}

const AI_APPS = ['kilo', 'lima', 'mike'];
const MC4_APP_SCORES: Array<[string, number]> = [
  ['sonarr', 9], ['radarr', 7], ['prowlarr', 8], ['seerr', 6], ['qbittorrent', 9], ['plex', 10],
];
const MC4_TORRENT_TITLES = [
  'The Life and Passion of Jesus Christ (1903)', 'A Trip to the Moon (1902)', 'The Great Train Robbery (1903)',
  'The Cabinet of Dr. Caligari (1920)', 'Nosferatu (1922)', 'The Phantom of the Opera (1925)',
  'The General (1926)', 'Metropolis (1927)', 'The Hunchback of Notre Dame (1923)', 'The Kid (1921)',
  'Sherlock Jr. (1924)', 'Safety Last! (1923)', 'The Mark of Zorro (1920)', 'The Sheik (1921)',
  'The Gold Rush (1925)', 'ubuntu-24.04-desktop-amd64.iso', 'debian-13.2-netinst.iso', 'archlinux-2026.09.01.iso',
];
const MC4_RECENT_TITLES = [
  'Metropolis (1927)', 'Nosferatu (1922)', 'The General (1926)', 'The Kid (1921)',
  'The Phantom of the Opera (1925)', 'A Trip to the Moon (1902)', 'The Cabinet of Dr. Caligari (1920)',
  'The Great Train Robbery (1903)', 'The Hunchback of Notre Dame (1923)', 'Sherlock Jr. (1924)',
];

// Exact per-request router and engine readings for MC1 and MC3; model-unused has no real request.
// Percentiles are seconds per request; decode readings are tok/s.
function modelPerf(q: string): unknown[] | undefined {
  const rows = (pairs: Array<[string, number]>, label = 'model') =>
    vec(pairs.map(([name, v]): [Record<string, string>, number] => [{ [label]: name }, v]));
  const now = Date.now() / 1000;
  switch (q) {
    case Q.llmUsed4d: return rows([['model-large', 310], ['model-coder', 880], ['model-small', 12], ['model-mini', 4]]);
    case Q.llmRequests1h: return rows([['model-large', 42], ['model-coder', 120], ['model-small', 6], ['model-mini', 0]]);
    case Q.llmRequestP50: return rows([['model-large', 1.84], ['model-coder', 0.62], ['model-small', 12.3]]);
    case Q.llmRequestP90: return rows([['model-large', 3.2], ['model-coder', 1.4], ['model-small', 48]]);
    case Q.llmRequestP99: return rows([['model-large', 5.6], ['model-coder', 2.9], ['model-small', 96.4]]);
    case Q.llmTtftP50: return rows([['model-large', 0.31], ['model-coder', 0.18]]);
    case Q.llmDecodeP50: return rows([['model-large', 104.2]], 'model_name');
    case Q.llmDecodeP90: return rows([['model-large', 88.4]], 'model_name');
    case Q.llmDecodeP99: return rows([['model-large', 61]], 'model_name');
    case Q.llmLastRequest: return rows([['model-large', now - 20], ['model-coder', now - 5], ['model-small', now - 600], ['model-mini', now - (3 * 3600 + 12 * 60)]]);
    case Q.llmLocalModels: return rows([['model-large', 1], ['model-coder', 1]]);
    default: return undefined;
  }
}

export function answer(q: string, opts: AnswerOpts = {}): unknown[] {
  const perf = modelPerf(q);
  if (perf) return perf;
  if (q.includes('AI · .+')) {
    const flat = config.groups.flatMap((g) => g.apps);
    return vec(AI_APPS.map((n): [Record<string, string>, number] => [{ name: n }, sampleAppScore(flat.indexOf(n))]));
  }
  if (q.includes('gatus_results_total') && q.includes('by (name)')) {
    const rows = config.groups.flatMap((g) => g.apps).map((n, i): [Record<string, string>, number] => [{ name: n }, sampleAppScore(i)]);
    return vec([
      ...rows.filter(([metric]) => metric.name !== 'juliet'),
      ...MC4_APP_SCORES.map(([name, score]): [Record<string, string>, number] => [{ name }, score]),
    ]);
  }
  if (q === Q.mc4QbitDownloadRate) return vec([[{}, 5 * 1024 ** 2]]);
  if (q === Q.mc4QbitUploadRate) return vec([[{}, 0.75 * 1024 ** 2]]);
  if (q === Q.mc4QbitDhtNodes) return vec([[{}, 432]]);
  if (q === Q.mc4QbitConnection) return vec([[{ status: 'connected' }, 1]]);
  if (q === Q.mc4TorrentProgress) return vec(MC4_TORRENT_TITLES.map((name, i) => [
    { name, state: i % 5 === 0 ? 'stalledUP' : 'stalledDL', category: name.endsWith('.iso') ? 'linux' : 'movies' },
    i % 5 === 0 ? 1 : Math.max(0.12, 0.94 - i * 0.035),
  ]));
  if (q === Q.mc4TorrentDownloadRate) return vec(MC4_TORRENT_TITLES.map((name, i) => [
    { name, state: i % 5 === 0 ? 'stalledUP' : 'stalledDL', category: name.endsWith('.iso') ? 'linux' : 'movies' },
    (MC4_TORRENT_TITLES.length - i) * 0.65 * 1024 ** 2,
  ]));
  if (q === Q.mc4TorrentUploadRate) return vec(MC4_TORRENT_TITLES.map((name, i) => [
    { name, state: i % 5 === 0 ? 'stalledUP' : 'stalledDL', category: name.endsWith('.iso') ? 'linux' : 'movies' },
    (i % 4) * 0.12 * 1024 ** 2,
  ]));
  if (q === Q.mc4TorrentShareRatio) return vec(MC4_TORRENT_TITLES.map((name, i) => [
    { name, state: i % 5 === 0 ? 'stalledUP' : 'stalledDL', category: name.endsWith('.iso') ? 'linux' : 'movies' },
    0.4 + i * 0.18,
  ]));
  if (q === Q.mc4LibraryDiskTotal) return vec([[{}, 48 * 1024 ** 4]]);
  if (q === Q.mc4LibraryDiskAvailable) return vec([[{}, 17 * 1024 ** 4]]);
  if (q === Q.mc4LibraryItems) return vec([
    [{ app: 'radarr' }, 18 * 1024 ** 4],
    [{ app: 'sonarr' }, 10 * 1024 ** 4],
  ]);
  if (q === Q.mc4PlexActiveSessions) return vec([[{}, 3]]);
  if (q === Q.mc4PlexSessions) return vec([
    [{ title: 'The General (1926)', decision: 'direct play', player: 'living room TV' }, 1],
    [{ title: 'Metropolis (1927)', decision: 'transcode', player: 'desktop browser' }, 1],
    [{ title: 'Nosferatu (1922)', decision: 'direct play', player: 'tablet' }, 1],
  ]);
  if (q === Q.mc4ArrQueue) return vec([
    [{ app: 'sonarr' }, 4], [{ app: 'radarr' }, 2], [{ app: 'prowlarr' }, 3], [{ app: 'seerr' }, 1],
  ]);
  if (q === Q.mc4ArrHealthIssues) return vec([
    [{ app: 'sonarr' }, 1], [{ app: 'radarr' }, 2],
  ]);
  if (q === Q.mc4VpnTunnel) return vec([[{}, 1]]);
  if (q === Q.mc4VpnHandshake) return vec([[{}, Date.now() / 1000 - 42]]);
  if (q === Q.mc4VpnKillswitch) return vec([[{}, 1]]);
  if (q === Q.mc4VpnPortForward) return vec([[{}, 1]]);
  if (q === Q.mc4RecentlyAdded) {
    const now = Date.now() / 1000;
    return vec(MC4_RECENT_TITLES.slice(0, 8).map((title, i) => [{ title }, now - (i + 1) * 3600]));
  }
  if (q.includes('gatus_results_total')) return vec([[{}, 99.93]]);
  if (q.includes('mode="idle"') && q.startsWith('count')) return vec(NODES.map((n, i) => [inst(n), [48, 24, 32][i]]));
  if (q.includes('mode="idle"')) return vec(NODES.map((n, i) => [inst(n), [34, 18, 52][i]]));
  if (q.includes('MemAvailable')) return vec(NODES.map((n, i) => [inst(n), [61, 72, 48][i]]));
  if (q.includes('MemTotal')) return vec(NODES.map((n, i) => [inst(n), [384, 144, 128][i] * 1e9]));
  if (q.includes('node_load1')) return vec(NODES.map((n, i) => [inst(n), [9.4, 3.1, 14.2][i]]));
  if (q.includes('hwmon')) return vec(NODES.map((n, i) => [inst(n), [44, 57, 60][i]]));
  if (q.includes('boot_time')) return vec(NODES.map((n, i) => [inst(n), (i + 1) * 20 * 86400]));
  if (q.includes('accelerator:busy_percent')) return vec([[{ accelerator: 'gpu-primary' }, 36], [{ accelerator: 'gpu-secondary' }, 64], [{ accelerator: 'mac-primary' }, 20]]);
  const SHARED_DEVICE = { device: 'shared-volume', mountpoint: '/mnt/shared-volume', fstype: 'nfs4' };
  if (q === Q.fsSize) {
    return vec([
      ...fixturePools.flatMap((pool, i) => [[{ ...inst(pool.node), device: pool.device, mountpoint: '/', fstype: 'zfs' }, pool.size], [{ ...inst(pool.node), device: `data-${String.fromCharCode(97 + i)}`, mountpoint: '/data', fstype: 'ext4' }, (i + 1) * 16e12]]),
      [{ ...inst('node-a'), ...SHARED_DEVICE }, 8e12],
      [{ ...inst('node-b'), ...SHARED_DEVICE }, 8e12],
    ] as Array<[Record<string, string>, number]>);
  }
  if (q === Q.fsAvail) {
    return vec([
      ...fixturePools.flatMap((pool, i) => [[{ ...inst(pool.node), device: pool.device, mountpoint: '/', fstype: 'zfs' }, pool.available], [{ ...inst(pool.node), device: `data-${String.fromCharCode(97 + i)}`, mountpoint: '/data', fstype: 'ext4' }, (i + 1) * 3e12]]),
      [{ ...inst('node-a'), ...SHARED_DEVICE }, 3e12],
      [{ ...inst('node-b'), ...SHARED_DEVICE }, 3e12],
    ] as Array<[Record<string, string>, number]>);
  }
  if (q === Q.pveStorageUsed) return vec(fixturePools.map((pool): [Record<string, string>, number] => [{ id: `storage/${pool.node}/${pool.name}` }, pool.pveUsed]));
  if (q === Q.wanRxBytes) return vec([[{ port: 'wan-a' }, 1e6], [{ port: 'wan-b' }, 2e6]]);
  if (q === Q.wanTxBytes) return vec([[{ port: 'wan-a' }, 0.5e6], [{ port: 'wan-b' }, 1e6]]);
  if (q === Q.vlanRxBytes) return vec(fixtureVlans.map((vlan): [Record<string, string>, number] => [{ network: vlan.network, vlan: vlan.vlan }, vlan.rx]));
  if (q === Q.vlanTxBytes) return vec(fixtureVlans.map((vlan): [Record<string, string>, number] => [{ network: vlan.network, vlan: vlan.vlan }, vlan.tx]));
  if (q === Q.gpuModel) return vec([
    [{ accelerator: 'gpu-primary', instance: 'gpu-a.device:9400', modelName: 'GPU-A' }, 1],
    [{ accelerator: 'gpu-primary', instance: 'gpu-a:9400', modelName: 'GPU-A' }, 1],
    [{ accelerator: 'gpu-secondary', instance: 'gpu-b.device:9400', modelName: 'GPU-B' }, 1],
    [{ accelerator: 'gpu-secondary', instance: 'gpu-b:9400', modelName: 'GPU-B' }, 1],
    [{ accelerator: 'gpu-secondary', instance: 'GPU-B:9401', modelName: 'GPU-B' }, 1],
    [{ accelerator: 'gpu-secondary', instance: 'gpu-c.device:9400', modelName: 'GPU-B' }, 1],
    [{ accelerator: 'gpu-secondary', instance: 'gpu-c:9400', modelName: 'GPU-B' }, 1],
  ]);
  if (q === Q.guestNode) return vec([
    [{ name: 'gpu-a', node: 'node-a' }, 1], [{ name: 'gpu-b', node: 'node-b' }, 1], [{ name: 'gpu-c', node: 'node-b' }, 1],
  ]);
  if (q === Q.acceleratorBusy) return vec([
    [{ accelerator: 'gpu-primary' }, 36], [{ accelerator: 'gpu-secondary' }, 64], [{ accelerator: 'mac-primary' }, 20],
  ]);
  if (q === Q.macChip) return vec([
    [{ accelerator: 'mac-primary', chip: 'DEVICE-A', instance: 'device-a:9100' }, 1],
    [{ accelerator: 'mac-secondary', chip: 'DEVICE-A', instance: 'device-b:9100' }, 1],
  ]);
  if (q === Q.llmApiBase) return vec([
    [{ litellm_model_name: 'model-large', api_base: 'http://gpu-a:8000/v1', api_provider: 'local' }, 1],
    [{ litellm_model_name: 'model-coder', api_base: 'http://GPU-B:8080/v1', api_provider: 'local' }, 1],
    [{ litellm_model_name: 'model-small', api_provider: 'provider-a' }, 1],
    [{ litellm_model_name: 'model-mini', api_provider: 'provider-b' }, 1],
    ...(opts.extraApiBase ?? []).map((labels): [Record<string, string>, number] => [labels, 1]),
  ]);
  if (q.includes('vllm:num_requests_running')) return vec([
    [{ instance: 'gpu-a:8000' }, opts.vllmRunning ?? 0],
    ...(opts.extraLocal ?? []).map(([instance, v]): [Record<string, string>, number] => [{ instance }, v]),
  ]);
  if (q.includes('llamacpp:requests_processing')) return vec([[{ instance: 'gpu-b:8080' }, opts.llamaRunning ?? 0]]);
  if (q.includes('litellm_in_flight_requests')) return vec([[{}, opts.inflight ?? 3]]);
  if (q.includes('litellm_deployment_state')) return vec([[{ litellm_model_name: 'model-large' }, 0], [{ litellm_model_name: 'model-coder' }, 0], [{ litellm_model_name: 'model-small' }, 2], [{ litellm_model_name: 'model-mini' }, 0], [{ litellm_model_name: 'model-unused' }, 0]]);
  if (q.includes('litellm_output_tokens')) return vec([[{ model: 'model-large' }, 38], [{ model: 'model-coder' }, 91]]);
  if (q === Q.llmTokensToday) return vec([[{ tag_telemetry_billing_class_local: 'true' }, 88_500_000], [{ tag_telemetry_billing_class_local: 'false' }, 10_300_000]]);
  if (q === Q.llmReqPerMin) return vec([[{ tag_telemetry_billing_class_local: 'true' }, 88], [{ tag_telemetry_billing_class_local: 'false' }, 11]]);
  if (q.includes('litellm_total_tokens_metric_total')) return vec([[{}, 4_810_000]]);
  if (q.includes('litellm_proxy_total_requests_metric_total')) return vec([[{}, 142]]);
  return [];
}

export interface FeedOpts extends AnswerOpts {
  failQuery?: (q: string) => boolean;
  emptyQuery?: (q: string) => boolean;
  recent?: unknown[] | ((n: number) => unknown[]);
  failWords?: boolean;
  emptyWords?: boolean;
}

export async function mockFeeds(page: Page, opts: FeedOpts = {}) {
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: config }));
  await mockGithub(page);
  await mockWords(page, opts);
  await page.route('**/api/prom/**', (r: Route) => {
    const url = new URL(r.request().url());
    const q = url.searchParams.get('query') || '';
    if (opts.failQuery?.(q)) return r.fulfill({ status: 500, json: { status: 'error', error: 'forced failure' } });
    const rows = opts.emptyQuery?.(q) ? [] : answer(q, opts);
    const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
    const step = Number(url.searchParams.get('step'));
    const result = url.pathname.endsWith('query_range')
      ? rows.map((x: any) => ({ metric: x.metric, values: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, k) => [start + k * step, String(20 + ((k * 7) % 50))]) }))
      : rows;
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result } } });
  });
  await mockRecent(page, opts);
}

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
  await page.route('**/api/**', (r: Route) => {
    const url = r.request().url();
    if (['/api/prom/', '/api/llm/recent', '/api/words', 'config.json'].some((p) => url.includes(p))) return r.fallback();
    return r.fulfill({ status: 404, body: 'no feed' });
  });
}
