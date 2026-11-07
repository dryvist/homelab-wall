import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Q } from '../site/lib/queries.js';

// Import the browser module with inert lifecycle hooks; canvas calls are recorded below.
const originals = { window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia };
globalThis.window = { addEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() {} };
globalThis.matchMedia = () => ({ matches: true });
const { drawSpark } = await import('../site/mc7/history.js');
const { loadBenchmarks, retainMeasurements, refreshFreshness, identities, INSTANT_KEYS, SOURCE_AGE_KEYS } = await import('../site/mc7/data.js');
const { BENCHMARK_SOURCE_AGE_FOR } = await import('../site/lib/benchmarkQueries.js');
after(() => Object.assign(globalThis, originals));

test('sparse live and snapshot ranges use shared timestamp and alignment options', async (t) => {
  t.mock.method(Date, 'now', () => 1_000_000);
  for (const snapshot of [false, true]) {
    const requests = [];
    const rows = [{ metric: { model: 'example' }, values: [[430, '2'], [445, '3'], [490, 'NaN'], [505, '5']] }];
    t.mock.method(globalThis, 'fetch', async (path) => {
      requests.push(path);
      const body = path === '/config.json' ? (snapshot ? { snapshot: '/snapshot.json' } : {})
        : path === '/snapshot.json' ? { range: { routerOutput: { result: rows } } }
          : { status: 'success', data: { result: rows } };
      return Response.json(body);
    });
    const { range } = await import(`../site/lib/prom.js?mode=${snapshot}`);
    const [series] = await range(Q.routerOutput, 10, 15, { timestamps: true, align: true });
    assert.deepEqual(series, {
      labels: { model: 'example' }, values: [[430, 2], [445, 3], [490, NaN], [505, 5]],
    });
    if (snapshot) assert.ok(requests.every((path) => !path.startsWith('/api/prom')));
    else {
      const params = new URL(requests[1], 'http://example.test').searchParams;
      assert.equal(params.get('start'), '390');
      assert.equal(params.get('end'), '990');
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
  const canvas = { clientWidth: 300, clientHeight: 30, dataset: {}, setAttribute() {}, getContext: () => context };
  const history = {
    start: 400, end: 1000, step: 15,
    values: [[385, 99], [430, 2], [445, 3], [490, 4], [505, NaN], [520, 5], [535, 6], [1000, 7], [1015, 99]],
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

test('MC7 polls its allow-listed queries and preserves failed readings with measurement times', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    requested.push(path);
    return Response.json(path === '/config.json' ? {} : { status: 'success', data: { result: [] } });
  });
  const raw = await loadBenchmarks();
  assert.ok(requested.some((path) => path.includes('query_range')));
  assert.deepEqual(Object.keys(raw).sort(), [...INSTANT_KEYS, ...SOURCE_AGE_KEYS, 'engineDecodeHistory', 'enginePrefillHistory', 'llmUsed4d'].sort());
  const row = { labels: { backend: 'vllm', model: 'example' }, value: 7, timestamp: 999 };
  raw.engineDecode = [row];
  raw[BENCHMARK_SOURCE_AGE_FOR.engineDecode] = [{ labels: row.labels, value: 999 }];
  raw.engineDecodeHistory = [{ values: [[990, 7]], start: 390, end: 990, step: 15 }];
  const fresh = retainMeasurements(raw);
  assert.equal(fresh.stale.size, 0);
  assert.deepEqual(identities(fresh.data), [row.labels]);
  assert.deepEqual(fresh.data.engineDecode, [{ ...row, sourceTimestamp: 999, measuredAt: 1000 }]);
  const failed = retainMeasurements(Object.fromEntries(Object.keys(raw).map((key) => [key, null])));
  assert.deepEqual(failed.data.engineDecode, [{ ...row, sourceTimestamp: 999, measuredAt: 1000 }]);
  assert.equal(failed.stale.has('engineDecode'), false);
  assert.equal(failed.data.engineDecodeHistory.length, 1);
  assert.equal(failed.data.engineDecodeHistory[0].staleSince, 1000);
  assert.ok(failed.stale.get('engineDecodeHistory').has(failed.data.engineDecodeHistory[0]));
  now += 301_000;
  assert.ok(refreshFreshness(failed).stale.get('engineDecode').has(failed.data.engineDecode[0]));
  assert.equal(failed.data.engineDecodeHistory.length, 1);
  assert.equal(failed.data.engineDecodeHistory[0].staleSince, 1000);
  assert.equal(failed.failed, true);
  raw.engineDecode = [{ ...row, value: NaN }];
  const recovered = retainMeasurements(raw);
  assert.deepEqual(recovered.data.engineDecode, []);
  assert.equal(recovered.stale.size, 0);
  assert.equal(recovered.failed, false);
});

test('history metadata uses the exact range request bounds across an async config boundary', async (t) => {
  const times = [1_000_000, 1_005_000];
  t.mock.method(Date, 'now', () => times.shift() ?? 1_005_000);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    requests.push(path);
    if (path.includes('query_range')) return Response.json({
      status: 'success', data: { result: [{ metric: {}, values: [[390, '1'], [990, '2']] }] },
    });
    return Response.json({ status: 'success', data: { result: [] } });
  });
  const raw = await loadBenchmarks();
  const history = raw.engineDecodeHistory[0];
  assert.equal(history.start, 390);
  assert.equal(history.end, 990);
  const params = new URL(requests.find((path) => path.includes('query_range')), 'https://wall.example.test').searchParams;
  assert.equal(params.get('start'), String(history.start));
  assert.equal(params.get('end'), String(history.end));
});

test('hung query requests count as failed refreshes after the ten second bound', async (t) => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    Promise.resolve().then(callback);
    return 1;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const paths = [];
  t.mock.method(globalThis, 'fetch', (path) => {
    paths.push(path);
    return new Promise(() => {});
  });
  const raw = await loadBenchmarks();
  assert.ok(paths.some((path) => path.includes('/api/prom/query')));
  assert.ok(paths.some((path) => path.includes('/api/prom/query_range')));
  assert.ok(delays.length > 0);
  assert.ok(delays.every((delay) => delay === 10_000));
  assert.ok(Object.values(raw).every((rows) => rows === null));
});

test('the source-age refresh timer starts while telemetry requests are still pending', async (t) => {
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = originalRaf; });
  const status = {};
  const panel = { dataset: {}, querySelector: () => null, children: [] };
  t.mock.method(document, 'getElementById', (id) => id === 'status' ? status : panel);
  const paths = [];
  t.mock.method(globalThis, 'fetch', (path) => {
    paths.push(path);
    return path === '/config.json' ? Promise.resolve(Response.json({ refreshSeconds: 15 })) : new Promise(() => {});
  });
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', (_callback, delay) => { intervals.push(delay); return intervals.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  await import('../site/mc7/mc7.js?independent-freshness');
  for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  assert.ok(intervals.includes(1000));
  assert.ok(paths.some((path) => path.includes('/api/prom/query')));
  assert.ok(paths.some((path) => path.includes('/api/prom/query_range')));
});

test('MC7 retries startup configuration after the ten second timeout', async (t) => {
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = originalRaf; });
  const status = {};
  t.mock.method(document, 'getElementById', (id) => id === 'status' ? status : { dataset: {}, querySelector: () => null, children: [] });
  let configs = 0;
  t.mock.method(globalThis, 'fetch', (path) => {
    if (path === '/config.json') {
      configs += 1;
      return configs === 1 ? new Promise(() => {}) : Promise.resolve(Response.json({ refreshSeconds: 15 }));
    }
    return new Promise(() => {});
  });
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', (_callback, delay) => { intervals.push(delay); return intervals.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  await import('../site/mc7/mc7.js?config-timeout-retry');
  const timeout = timers.find((timer) => timer.delay === 10_000);
  assert.ok(timeout);
  timeout.callback();
  await new Promise((resolve) => setImmediate(resolve));
  const retry = timers.filter((timer) => timer.delay === 10_000).at(-1);
  assert.notEqual(retry, timeout);
  retry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configs, 2);
  assert.ok(intervals.includes(1000));
});

test('MC7 continues polling after a render failure', async (t) => {
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = originalRaf; });
  const status = {};
  const panel = { dataset: {}, querySelector: () => null, children: [] };
  Object.defineProperty(panel, 'innerHTML', { set() { throw new Error('render failed'); } });
  t.mock.method(document, 'getElementById', (id) => id === 'status' ? status : panel);
  t.mock.method(globalThis, 'fetch', async (path) => path === '/config.json'
    ? Response.json({ refreshSeconds: 15 })
    : Response.json({ status: 'success', data: { result: [] } }));
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (_callback, delay) => { timers.push(delay); return timers.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  await import('../site/mc7/mc7.js?render-failure-retry');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timers.includes(15_000));
  assert.match(status.textContent, /Telemetry refresh failed/);
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].message, /render failed/);
});

test('guest-only llama.cpp query results render distinct cards and device associations', async (t) => {
  const { renderBenchmarks } = await import('../site/mc7/render.js');
  const panels = Object.fromEntries(['engines', 'routers'].map((key) => [key, {
    dataset: {}, querySelector: () => null,
    children: [{ querySelectorAll: () => [] }, { querySelectorAll: () => [] }],
  }]));
  t.mock.method(document, 'getElementById', (id) => panels[id]);
  // Source labels contain no model metadata; the query adds backend and groups by guest.
  const source = { accelerator: 'gpu-secondary', guest: 'engine-embed', instance: 'example.test:8080', job: 'llm_gpu_engine' };
  const labels = { backend: 'llamacpp', guest: source.guest };
  const second = { backend: 'llamacpp', guest: 'engine-classify' };
  const data = {
    engineDecode: [{ labels, value: 25 }, { labels: second, value: 12 }],
    engineRunning: [{ labels, value: 1 }],
    engineDevices: [{ labels: { ...labels, accelerator: source.accelerator }, value: 1 }],
    acceleratorWatts: [{ labels: { accelerator: source.accelerator }, value: 100 }],
  };
  assert.deepEqual(identities(data), [second, labels]);
  renderBenchmarks({ data, stale: new Map(), failed: false });
  assert.match(panels.engines.innerHTML, /<h3>engine-embed · llama.cpp<\/h3>/);
  assert.match(panels.engines.innerHTML, /<h3>engine-classify · llama.cpp<\/h3>/);
  assert.match(panels.engines.innerHTML, /data-metric="engineDecode"[^>]*>25\.0/);
  assert.match(panels.engines.innerHTML, /data-metric="acceleratorWatts"[^>]*>100\.0 W/);
  assert.doesNotMatch(panels.engines.innerHTML, /undefined|NaN/);
});
