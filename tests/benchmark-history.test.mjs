import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Q } from '../site/lib/queries.js';

// Import the browser module with inert lifecycle hooks; canvas calls are recorded below.
const originals = { window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia };
globalThis.window = { addEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() {} };
globalThis.matchMedia = () => ({ matches: true });
const { drawSpark, loadBenchmarks, renderBenchmarks } = await import('../site/mc3/benchmarks.js');
after(() => Object.assign(globalThis, originals));

test('sparse live and snapshot ranges retain timestamps, bounds, and numeric values', async (t) => {
  t.mock.method(Date, 'now', () => 1_000_000);
  for (const snapshot of [false, true]) {
    const requests = [];
    const rows = [{ metric: { model: 'example' }, values: [[430, '2'], [445, '3'], [490, 'NaN'], [505, '5']] }];
    t.mock.method(globalThis, 'fetch', async (path) => {
      requests.push(path);
      const body = path === '/config.json' ? (snapshot ? { snapshot: '/snapshot.json' } : {})
        : path === '/snapshot.json' ? { range: { llmTokRate: { result: rows } } }
          : { status: 'success', data: { result: rows } };
      return Response.json(body);
    });
    const { range } = await import(`../site/lib/prom.js?mode=${snapshot}`);
    const [series] = await range(Q.llmTokRate, 10, 15);
    assert.deepEqual(series, {
      labels: { model: 'example' }, values: [2, 3, NaN, 5],
      timestamps: [430, 445, 490, 505], start: 400, end: 1000, step: 15,
    });
    if (snapshot) assert.ok(requests.every((path) => !path.startsWith('/api/prom')));
    else {
      const params = new URL(requests[1], 'http://example.test').searchParams;
      assert.equal(params.get('start'), '400');
      assert.equal(params.get('end'), '1000');
      assert.equal(params.get('step'), '15');
    }
  }
});

test('sparklines use the requested window and break on absent or nonfinite samples', () => {
  const calls = [];
  const context = {
    clearRect() {}, beginPath() {}, stroke() {},
    moveTo(x, y) { calls.push(['move', x, y]); },
    lineTo(x, y) { calls.push(['line', x, y]); },
  };
  const canvas = { clientWidth: 300, clientHeight: 30, dataset: {}, getContext: () => context };
  const history = {
    start: 400, end: 1000, step: 15,
    timestamps: [385, 430, 445, 490, 505, 520, 535, 1000, 1015],
    values: [99, 2, 3, 4, NaN, 5, 6, 7, 99],
  };
  drawSpark(canvas, history, '#fff');
  assert.equal(canvas.dataset.samples, '6');
  assert.deepEqual(calls.map(([op, x]) => [op, x]), [
    ['move', 30], ['line', 45], ['move', 90], ['move', 120], ['line', 135], ['move', 600],
  ]);
  calls.length = 0;
  drawSpark(canvas, undefined, '#fff');
  assert.equal(canvas.dataset.samples, '0');
  assert.deepEqual(calls, []);
});

test('MC3 never polls corrupted summaries and ignores any supplied router timing numbers', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    requested.push(path);
    return Response.json(path === '/config.json' ? {} : { status: 'success', data: { result: [] } });
  });
  await loadBenchmarks();
  assert.ok(requested.some((path) => path.includes('query_range')));
  for (const path of requested) assert.doesNotMatch(decodeURIComponent(path), /_sum\b|_count\b/);

  const tab = { style: {}, classList: { toggle() {} }, children: [{ querySelectorAll: () => [] }] };
  const nodes = { modeltab: tab, coresum: {}, cores: { dataset: {}, querySelector: () => null } };
  t.mock.method(globalThis.document, 'getElementById', (id) => nodes[id]);
  renderBenchmarks([{ n: 'example', anchor: 0, up: true, tok: 7, queue: 123, latencyMs: 123 }], {
    routerTtftAvg: [{ labels: { model: 'example' }, value: 123 }],
    routerItlAvg: [{ labels: { model: 'example' }, value: 123 }],
  }, [{ id: 'gpu-primary', name: 'Example accelerator' }]);
  assert.equal(tab.innerHTML.match(/NO DATA · router averages pending ingest fix/g).length, 3);
  assert.doesNotMatch(tab.innerHTML, /123|stand-in/);
  assert.match(tab.innerHTML, /7\.0/);
});
