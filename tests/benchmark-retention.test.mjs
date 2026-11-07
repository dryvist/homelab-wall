import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a successful empty poll holds a row until its source age exceeds five minutes', async (t) => {
  const now = 1_700_000_000;
  let clock = now * 1000;
  t.mock.method(Date, 'now', () => clock);
  const { retainMeasurements, refreshFreshness, INSTANT_KEYS, SOURCE_AGE_KEYS } = await import('../site/mc7/data.js');
  const { BENCHMARK_SOURCE_AGE_FOR } = await import('../site/lib/benchmarkQueries.js');
  const labels = { backend: 'vllm', model: 'held-after-empty' };
  const ageKey = BENCHMARK_SOURCE_AGE_FOR.engineDecode;
  const initial = Object.fromEntries([...INSTANT_KEYS, ...SOURCE_AGE_KEYS].map((key) => [key, []]));
  initial.engineDecode = [{ labels, value: 7 }];
  initial[ageKey] = [{ labels, value: now }];
  const held = retainMeasurements(initial);
  const empty = retainMeasurements({ ...initial, engineDecode: [], [ageKey]: [] });
  const row = empty.data.engineDecode.find((item) => item.labels.model === labels.model);
  assert.equal(row.value, 7);
  assert.equal(empty.stale.get('engineDecode'), undefined);

  clock += 300_000;
  assert.equal(refreshFreshness(empty).stale.get('engineDecode'), undefined);
  clock += 1000;
  assert.ok(refreshFreshness(empty).stale.get('engineDecode').has(row));
  assert.ok(held.data.engineDecode.some((item) => item.labels.model === labels.model));
});

async function setup(t, now) {
  const clock = { ms: now * 1000 };
  t.mock.method(Date, 'now', () => clock.ms);
  const data = await import('../site/mc7/data.js');
  const { BENCHMARK_SOURCE_AGE_FOR } = await import('../site/lib/benchmarkQueries.js');
  const empty = Object.fromEntries([...data.INSTANT_KEYS, ...data.SOURCE_AGE_KEYS].map((key) => [key, []]));
  return { ...data, clock, empty, ageFor: BENCHMARK_SOURCE_AGE_FOR };
}

test('every percentile reads Idle while its source is fresh', async (t) => {
  const now = 1_700_100_000;
  const { retainMeasurements, empty, ageFor } = await setup(t, now);
  const labels = { backend: 'vllm', model: 'idle-percentiles' };
  const raw = { ...empty };
  for (const key of ['engineTtftP50', 'engineTtftP95', 'engineTtftP99', 'engineItlP50']) {
    raw[key] = [{ labels, value: NaN }];
    raw[ageFor[key]] = [{ labels, value: now - 2 }];
  }
  const { data } = retainMeasurements(raw);
  for (const key of ['engineTtftP50', 'engineTtftP95', 'engineTtftP99', 'engineItlP50']) {
    assert.equal(data[key].find((row) => row.labels.model === labels.model)?.idle, true, key);
  }
});

test('a held row keeps its last source time when only its age row is current', async (t) => {
  const now = 1_700_200_000;
  const { retainMeasurements, refreshFreshness, clock, empty, ageFor } = await setup(t, now);
  const labels = { backend: 'vllm', model: 'held-without-value' };
  const ageKey = ageFor.enginePrefixPercent;
  retainMeasurements({ ...empty, enginePrefixPercent: [{ labels, value: 40 }], [ageKey]: [{ labels, value: now }] });
  clock.ms += 600_000;
  const later = refreshFreshness(retainMeasurements({ ...empty, [ageKey]: [{ labels, value: now + 599 }] }));
  const row = later.data.enginePrefixPercent.find((item) => item.labels.model === labels.model);
  assert.equal(row.value, 40);
  assert.equal(row.sourceTimestamp, now);
  assert.ok(later.stale.get('enginePrefixPercent').has(row));
});

test('a row unmeasured for over an hour is dropped', async (t) => {
  const now = 1_700_300_000;
  const { retainMeasurements, clock, empty, ageFor, identities } = await setup(t, now);
  const labels = { backend: 'vllm', model: 'retired-engine' };
  const ageKey = ageFor.engineDecode;
  retainMeasurements({ ...empty, engineDecode: [{ labels, value: 9 }], [ageKey]: [{ labels, value: now }] });
  clock.ms += 3_600_000;
  assert.ok(retainMeasurements(empty).data.engineDecode.some((row) => row.labels.model === labels.model));
  clock.ms += 1000;
  const { data } = retainMeasurements(empty);
  assert.equal(data.engineDecode.some((row) => row.labels.model === labels.model), false);
  assert.equal(identities(data).some((id) => id.model === labels.model), false);
});

test('a row with no source time survives a failed poll, stale', async (t) => {
  const now = 1_700_400_000;
  const { retainMeasurements, refreshFreshness, clock, empty } = await setup(t, now);
  const labels = { backend: 'vllm', model: 'no-source-time' };
  retainMeasurements({ ...empty, engineDecode: [{ labels, value: 3 }] });
  clock.ms += 15_000;
  const failed = Object.fromEntries(Object.keys(empty).map((key) => [key, null]));
  const result = refreshFreshness(retainMeasurements(failed));
  const row = result.data.engineDecode.find((item) => item.labels.model === labels.model);
  assert.equal(row?.value, 3);
  assert.ok(result.stale.get('engineDecode').has(row));
});

test('rows stored before measuredAt leave an hour after their stored poll', async (t) => {
  const now = 1_700_500_000;
  const { retainMeasurements, clock, empty } = await setup(t, now);
  const { lastGoodSet } = await import('../site/lib/lastGood.js');
  const labels = { backend: 'vllm', model: 'stored-before-measured-at' };
  lastGoodSet('mc7:engineDecode', [{ labels, value: 2 }]);
  const has = (result) => result.data.engineDecode.some((row) => row.labels.model === labels.model);
  clock.ms += 1_800_000;
  assert.ok(has(retainMeasurements(empty)));
  clock.ms += 1_801_000;
  assert.equal(has(retainMeasurements(empty)), false);
});
