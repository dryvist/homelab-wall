// Synthetic data only — never recorded from a real system.
import type { Page, Route } from '@playwright/test';

export const config = {
  title: 'HOMELAB',
  refreshSeconds: 15,
  guestCount: 42,
  nodeRoles: { 'node-a': 'compute', 'node-b': 'storage', 'node-c': 'workstation' },
  extraNodes: [{ name: 'studio', role: 'inference · not PVE' }],
  groups: [
    { name: 'apps', apps: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] },
    { name: 'media', apps: ['foxtrot', 'golf', 'hotel'] },
    { name: 'observ', apps: ['india', 'juliet'] },
    { name: 'ai', apps: ['kilo', 'lima', 'mike'] },
  ],
};

const NODES = ['node-a', 'node-b', 'node-c'];
const inst = (n: string) => ({ instance: `${n}.example.test:9100`, job: 'pve_node_exporter' });
const vec = (rows: Array<[Record<string, string>, number]>) =>
  rows.map(([metric, v]) => ({ metric, value: [Date.now() / 1000, String(v)] }));

function answer(q: string): unknown[] {
  if (q.includes('gatus_results_total') && q.includes('by (name)')) {
    return vec(config.groups.flatMap((g) => g.apps).map((n, i): [Record<string, string>, number] => [{ name: n }, i === 3 ? 22 : i === 6 ? 71 : 92 + (i % 8)]));
  }
  if (q.includes('gatus_results_total')) return vec([[{}, 99.93]]);
  if (q.includes('mode="idle"') && q.startsWith('count')) return vec(NODES.map((n, i) => [inst(n), [48, 24, 32][i]]));
  if (q.includes('mode="idle"')) return vec(NODES.map((n, i) => [inst(n), [34, 18, 52][i]]));
  if (q.includes('MemAvailable')) return vec(NODES.map((n, i) => [inst(n), [61, 72, 48][i]]));
  if (q.includes('MemTotal')) return vec(NODES.map((n, i) => [inst(n), [384, 144, 128][i] * 1e9]));
  if (q.includes('node_load1')) return vec(NODES.map((n, i) => [inst(n), [9.4, 3.1, 14.2][i]]));
  if (q.includes('hwmon')) return vec(NODES.map((n, i) => [inst(n), [44, 57, 60][i]]));
  if (q.includes('boot_time')) return vec(NODES.map((n, i) => [inst(n), (i + 1) * 20 * 86400]));
  if (q.includes('filesystem_size')) {
    return vec(NODES.flatMap((n, i) => [[{ ...inst(n), device: `pool${i}`, mountpoint: '/' }, (i + 2) * 4e12], [{ ...inst(n), device: `data${i}`, mountpoint: '/data' }, (i + 1) * 16e12]]));
  }
  if (q.includes('filesystem_avail')) {
    return vec(NODES.flatMap((n, i) => [[{ ...inst(n), device: `pool${i}`, mountpoint: '/' }, (i + 2) * 1.5e12], [{ ...inst(n), device: `data${i}`, mountpoint: '/data' }, (i + 1) * 3e12]]));
  }
  if (q.includes('litellm_deployment_state')) return vec([[{ litellm_model_name: 'model-large' }, 0], [{ litellm_model_name: 'model-coder' }, 0], [{ litellm_model_name: 'model-small' }, 2]]);
  if (q.includes('litellm_output_tokens')) return vec([[{ model: 'model-large' }, 38], [{ model: 'model-coder' }, 91]]);
  return [];
}

export async function mockFeeds(page: Page) {
  await page.route('**/config.json', (r: Route) => r.fulfill({ json: config }));
  await page.route('**/api/prom/**', (r: Route) => {
    const url = new URL(r.request().url());
    const q = url.searchParams.get('query') || '';
    const rows = answer(q);
    const result = url.pathname.endsWith('query_range')
      ? rows.map((x: any) => ({ metric: x.metric, values: Array.from({ length: 60 }, (_, k) => [k, String(20 + ((k * 7) % 50))]) }))
      : rows;
    return r.fulfill({ json: { status: 'success', data: { resultType: 'vector', result } } });
  });
}
