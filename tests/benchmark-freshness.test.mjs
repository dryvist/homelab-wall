import { test } from 'node:test';
import assert from 'node:assert/strict';

test('frozen snapshots age per measurement, retain source times on failure, and never refresh on receipt', async (t) => {
  const captured = 1_700_000_000;
  let now = (captured + 200) * 1000;
  t.mock.method(Date, 'now', () => now);
  const panels = Object.fromEntries(['engines', 'routers'].map((id) => [id, {
    dataset: {}, querySelector: () => null,
    children: Array.from({ length: 4 }, () => ({ querySelectorAll: () => [] })),
  }]));
  const originals = { window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia };
  t.after(() => Object.assign(globalThis, originals));
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = {
    hidden: false, addEventListener() {}, getElementById: (id) => panels[id],
  };
  const { loadBenchmarks, retainMeasurements, refreshFreshness, INSTANT_KEYS, SOURCE_AGE_KEYS } = await import('../site/mc7/data.js');
  const { BENCHMARK_SOURCE_AGE_Q, BENCHMARK_SOURCE_AGE_FOR } = await import('../site/lib/benchmarkQueries.js');
  const { renderBenchmarks } = await import('../site/mc7/render.js');
  const labels = { backend: 'vllm', model: 'older' };
  const newer = { backend: 'vllm', model: 'newer' };
  const snapshot = {
    // Even a newly published envelope must not refresh an old measurement.
    generated_at: new Date(now).toISOString(),
    instant: Object.fromEntries([...INSTANT_KEYS, ...SOURCE_AGE_KEYS].map((key) => [key, { result: key === 'engineDecode' ? [
      { metric: labels, value: [captured, '7'] },
      { metric: newer, value: [captured + 200, '8'] },
    ] : key === BENCHMARK_SOURCE_AGE_FOR.engineDecode ? [
      { metric: labels, value: [captured, String(captured)] },
      { metric: newer, value: [captured + 200, String(captured + 200)] },
    ] : [] }])),
    range: Object.fromEntries(['engineDecode', 'enginePrefill'].map((key) => [key, {
      result: [{ metric: labels, values: [[captured - 15, '6'], [captured, '7']] }],
    }])),
  };
  t.mock.method(globalThis, 'fetch', async (path) => {
    assert.ok(['/config.json', '/snapshot.json'].includes(path));
    return Response.json(path === '/config.json' ? { snapshot: '/snapshot.json' } : snapshot);
  });
  const first = await loadBenchmarks();
  assert.equal(first[BENCHMARK_SOURCE_AGE_FOR.engineDecode][0].value, captured);
  assert.ok(BENCHMARK_SOURCE_AGE_Q[BENCHMARK_SOURCE_AGE_FOR.engineDecode].includes('tlast_over_time'));
  assert.deepEqual(first.engineDecodeHistory[0].values, [[captured - 15, 6], [captured, 7]]);
  assert.equal(first.engineDecodeHistory[0].end % 15, 0);
  const fresh = retainMeasurements(first);
  renderBenchmarks(fresh);
  const measured = `Last measured ${new Date(captured * 1000).toISOString()}`;
  assert.ok(panels.engines.innerHTML.includes(measured));
  assert.equal(fresh.data.engineDecode[0].sourceTimestamp, captured);
  assert.equal(fresh.stale.size, 0);

  now += 100_000;
  assert.equal(refreshFreshness(fresh).stale.size, 0);
  now += 1000;
  const aged = refreshFreshness(fresh).stale.get('engineDecode');
  assert.equal(aged.size, 1);
  assert.equal([...aged][0].labels.model, 'older');
  snapshot.generated_at = new Date(now).toISOString();
  const frozen = retainMeasurements(await loadBenchmarks());
  assert.equal(frozen.failed, false);
  assert.deepEqual([...frozen.stale.get('engineDecode')].map((row) => row.labels.model), ['older']);
  renderBenchmarks(frozen);
  assert.ok(panels.engines.innerHTML.includes(measured));
  assert.match(panels.engines.innerHTML, /data-state="stale">7\.0 · STALE 5m 1s/);
  assert.match(panels.engines.innerHTML, />8\.0<\/b>/);

  const failed = retainMeasurements(Object.fromEntries(Object.keys(first).map((key) => [key, null])));
  renderBenchmarks(failed);
  assert.ok(panels.engines.innerHTML.includes(measured));
  assert.equal(failed.stale.get('engineDecode').size, 1);
  assert.match(panels.engines.innerHTML, /data-metric="engineDecode"[^>]*>8\.0<\/b>/);
  assert.equal(failed.data.engineDecodeHistory.length, 1);
  assert.equal(failed.data.engineDecodeHistory[0].staleSince, (captured + 301));
  assert.ok(failed.stale.get('engineDecodeHistory').has(failed.data.engineDecodeHistory[0]));
  assert.match(panels.engines.innerHTML, /<small data-state="stale">STALE 0s<\/small>/);

  const unknownLabels = { backend: 'vllm', model: 'unmeasured' };
  const unknown = retainMeasurements({ ...first, engineDecode: [{ labels: unknownLabels, value: 7 }], [BENCHMARK_SOURCE_AGE_FOR.engineDecode]: [] });
  renderBenchmarks(unknown);
  assert.match(panels.engines.innerHTML, /Measurement time unavailable/);
  assert.match(panels.engines.innerHTML, /7\.0 · STALE/);
});

test('measurement tooltips show the source sample time, never the evaluation time', async (t) => {
  const panels = Object.fromEntries(['engines', 'routers'].map((id) => [id, {
    dataset: {}, querySelector: () => null, children: [{ querySelectorAll: () => [] }],
  }]));
  const originals = { window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia };
  t.after(() => Object.assign(globalThis, originals));
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = { hidden: false, addEventListener() {}, getElementById: (id) => panels[id] };
  const { renderBenchmarks } = await import('../site/mc7/render.js');
  const labels = { backend: 'vllm', model: 'example' };
  const sourceTime = 1_700_000_100, evaluationTime = 1_700_000_500;
  renderBenchmarks({
    data: { engineDecode: [{ labels, value: 7, timestamp: evaluationTime, sourceTimestamp: sourceTime }] },
    stale: new Map(),
    failed: false,
  });
  assert.ok(panels.engines.innerHTML.includes(`Last measured ${new Date(sourceTime * 1000).toISOString()}`));
  assert.ok(!panels.engines.innerHTML.includes(new Date(evaluationTime * 1000).toISOString()));
});

test('source timestamps up to five seconds ahead are clamped; farther future ages are stale', async (t) => {
  const now = 1_700_000_000;
  t.mock.method(Date, 'now', () => now * 1000);
  const { refreshFreshness } = await import('../site/mc7/data.js');
  const accepted = { labels: { model: 'accepted' }, value: 1, sourceTimestamp: now + 5 };
  const rejected = { labels: { model: 'rejected' }, value: 2, sourceTimestamp: now + 6 };
  const result = refreshFreshness({ data: { engineDecode: [accepted, rejected] }, failed: false });
  assert.equal(result.data.engineDecode[0].sourceTimestamp, now);
  assert.equal(result.stale.has('engineDecode'), true);
  assert.deepEqual([...result.stale.get('engineDecode')], [{ ...rejected, sourceTimestamp: undefined }]);
});

test('fresh NaN p95 readings render Idle and engine staleness stays in the engine panel', async (t) => {
  const captured = 1_700_000_000;
  t.mock.method(Date, 'now', () => captured * 1000);
  const panels = Object.fromEntries(['engines', 'routers'].map((id) => [id, {
    dataset: {}, querySelector: () => null,
    children: Array.from({ length: 10 }, () => ({ querySelectorAll: () => [] })),
  }]));
  const originals = { window: globalThis.window, document: globalThis.document, matchMedia: globalThis.matchMedia };
  t.after(() => Object.assign(globalThis, originals));
  globalThis.window = { addEventListener() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = { hidden: false, addEventListener() {}, getElementById: (id) => panels[id] };
  const { retainMeasurements, INSTANT_KEYS, SOURCE_AGE_KEYS } = await import('../site/mc7/data.js');
  const { BENCHMARK_SOURCE_AGE_FOR } = await import('../site/lib/benchmarkQueries.js');
  const { renderBenchmarks } = await import('../site/mc7/render.js');
  const engine = { backend: 'vllm', model: 'idle-p95-case' };
  const router = { model: 'fresh-router-case' };
  const ageKey = BENCHMARK_SOURCE_AGE_FOR.engineTtftP95;
  const initial = Object.fromEntries([...INSTANT_KEYS, ...SOURCE_AGE_KEYS].map((key) => [key, []]));
  initial.engineTtftP95 = [{ labels: engine, value: 0.4 }];
  initial[ageKey] = [{ labels: engine, value: captured }];
  retainMeasurements(initial);
  const idleRaw = { ...initial, engineTtftP95: [{ labels: engine, value: NaN }], routerTtftP50: [{ labels: router, value: 0.2 }] };
  const idle = retainMeasurements(idleRaw);
  const idleRow = idle.data.engineTtftP95.find((row) => row.labels.model === engine.model);
  assert.equal(idleRow.idle, true);
  assert.equal(idleRow.sourceTimestamp, captured);
  const watts = { labels: { accelerator: 'gpu-primary' }, value: 300, sourceTimestamp: captured - 400 };
  const stale = new Map([['acceleratorWatts', new Set([watts])]]);
  renderBenchmarks({
    data: { ...idle.data, acceleratorWatts: [watts] }, stale, failed: false,
  });
  assert.match(panels.engines.innerHTML, /data-metric="engineTtftP95"[^>]*>Idle<\/b>/);
  assert.equal(panels.engines.dataset.state, 'stale');
  assert.equal(panels.routers.dataset.state, 'ok');
});
