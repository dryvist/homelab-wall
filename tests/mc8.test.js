import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shapeRates, splitTopByRate, splitInFlight, providerClass, retain, fresh, increased, modelKey } from '../site/mc8/data.js';
import { Q } from '../site/lib/queries.js';
import * as mc8Data from '../site/mc8/data.js';

const row = (value, labels = {}, timestamp = 1) => ({ value, labels, timestamp });
const billing = (bank) => Object.fromEntries(['local', 'subscription', 'paid', 'free'].map((key) => [`tag_telemetry_billing_class_${key}`, String(key === bank)]));
const H = 'api_key_alias!="litellm-internal-health-check"';
test('top-rate split preserves the highest rows and totals collapsed rows', () => {
  const rows = [
    { id: 'c', rate: 3 }, { id: 'a', rate: 9 }, { id: 'e', rate: 1 },
    { id: 'b', rate: 7 }, { id: 'd', rate: 2 },
  ];
  const split = splitTopByRate(rows, 3);
  assert.deepEqual(split.visible.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(split.more, { count: 3, rate: 6, localRate: null, cloudRate: 6 });
  assert.equal(splitTopByRate(rows, 5).more, null);
  assert.deepEqual(rows.map((item) => item.id), ['c', 'a', 'e', 'b', 'd']);
});

test('rates merge input and output by caller, team, model, and provider', () => {
  const a = { api_key_alias: 'caller-a', team: 'team-a', model: 'model-a', api_provider: 'hosted_vllm', ...billing('local') };
  const b = { ...a, model: 'model-b', api_provider: 'openrouter', ...billing('paid') };
  const graph = shapeRates([row(60, a), row(30, b)], [row(10, a)]);
  assert.equal(graph.callers.length, 1);
  assert.equal(graph.callers[0].rate, 100);
  assert.equal(graph.callers[0].localRate, 70);
  assert.equal(graph.callers[0].cloudRate, 30);
  assert.equal(graph.total, 100);
  assert.equal(graph.localRate, 70);
  assert.equal(graph.cloudRate, 30);
  assert.equal(graph.localShare, 70);
  assert.deepEqual(graph.routes.map((r) => r.rate), [70, 30]);
  assert.deepEqual(graph.routes.map(({ localRate, cloudRate }) => [localRate, cloudRate]), [[70, null], [null, 30]]);
  assert.deepEqual(graph.models.map((m) => m.bank), ['local', 'paid']);
});
test('in-flight values use local engines and the clamped router remainder', () => {
  assert.deepEqual(splitInFlight([row(3)], [row(1), row(2)], [row(1)]), { local: 4, cloud: 0 });
  assert.deepEqual(splitInFlight([row(5)], [row(2)], [row(1)]), { local: 3, cloud: 2 });
  assert.deepEqual(splitInFlight(null, [row(2)], [row(1)]), { local: 3, cloud: null });
  assert.deepEqual(splitInFlight([row(5)], [], [row(1)]), { local: null, cloud: null });
});
test('missing identity is explicit, team fallback works, and matching aliases in different teams stay separate', () => {
  const graph = shapeRates([row(1), row(2, { team: 'team-a' }), row(3, { api_key_alias: 'agent', team: 'a' }), row(4, { api_key_alias: 'agent', team: 'b' })], []);
  assert.equal(graph.callers.length, 4);
  assert.ok(graph.callers.some((c) => c.name === 'Unattributed caller'));
  assert.ok(graph.callers.some((c) => c.name === 'team-a'));
  assert.equal(graph.models.length, 1);
});
test('same model on different providers remains distinct; unknown providers are not guessed', () => {
  const graph = shapeRates([row(2, { model: 'm', api_provider: 'openai' }), row(3, { model: 'm', api_provider: 'other' })], []);
  assert.equal(graph.models.length, 2);
  assert.equal(providerClass({ api_provider: 'openai' }), 'unknown');
  assert.equal(providerClass({ api_provider: 'hosted_vllm' }), 'unknown');
  assert.equal(providerClass({ api_provider: 'openrouter', ...billing('unknown') }), 'unknown');
});
test('billing flags, never provider, determine every bank and local share', () => {
  for (const bank of ['local', 'subscription', 'paid', 'free', 'unknown']) {
    assert.equal(providerClass({ api_provider: 'openai', ...billing(bank) }), bank);
  }
  const labels = { model: 'm', api_provider: 'openai' };
  const graph = shapeRates([row(3, { ...labels, ...billing('local') }), row(7, { ...labels, ...billing('unknown') })], []);
  assert.equal(graph.models.length, 2);
  assert.equal(graph.localShare, 100);
  assert.equal(graph.unclassifiedShare, 100);
  assert.equal(graph.total, 10);
});
test('local share excludes unclassified traffic and reports its coverage separately', () => {
  const graph = shapeRates([row(3, billing('local')), row(1, billing('paid'))], [row(6)]);
  assert.equal(graph.localShare, 75);
  assert.ok(Math.abs(graph.unclassifiedShare - (6 / 7) * 100) < 1e-9);
  const unknown = shapeRates([row(10)], []);
  assert.equal(unknown.localShare, null);
  assert.equal(unknown.unclassifiedShare, 100);
  const nonlocal = shapeRates([row(10, billing('paid'))], []);
  assert.equal(nonlocal.localShare, 0);
  assert.equal(nonlocal.unclassifiedShare, 0);
});
test('idle is measured zero; empty, NaN, infinity and negative values are never fabricated measurements', () => {
  assert.equal(shapeRates([], []).localShare, null);
  const graph = shapeRates([row(0), row(NaN), row(Infinity), row(-1)], []);
  assert.equal(graph.total, 0);
  assert.equal(graph.routes.length, 1);
  assert.equal(graph.localShare, null);
});
test('empty or failed polls retain last good data and time; valid zero recovers', () => {
  assert.equal(retain(null, [], 1).state, 'pending');
  assert.equal(retain(null, null, 1).state, 'pending');
  // A successful empty failure poll is zero failures, measured at its poll time, while router liveness is fresh.
  assert.deepEqual(retain(null, [], 1, { emptyIsZero: true, liveAt: 1 }), { rows: [], at: 1, state: 'ok' });
  const good = retain(null, [row(4)], 1000);
  for (const rows of [null, []]) {
    assert.deepEqual(retain(good, rows, 2000), { ...good, state: 'stale' });
  }
  // Zero request rate makes p95 NaN: a fresh source time is an idle router, an old one is stale.
  assert.deepEqual(retain(good, [{ ...row(NaN), sourceTime: 1.5 }], 2000), { rows: [], at: 1500, state: 'idle' });
  assert.deepEqual(retain(good, [{ ...row(NaN), sourceTime: 1 }], 400000), { ...good, state: 'stale' });
  assert.deepEqual(retain(good, [row(0, {}, 3)], 3000), { rows: [row(0, {}, 3)], at: 3000, state: 'ok' });
});
test('a failed poll after a measured zero or an idle reading holds its time and goes stale', () => {
  const zero = retain(null, [], 1000000, { emptyIsZero: true, liveAt: 999000 });
  assert.deepEqual(retain(zero, null, 1015000, { emptyIsZero: true, liveAt: 999000 }), { rows: [], at: 1000000, state: 'stale' });
  const idle = retain(null, [{ ...row(NaN), sourceTime: 999 }], 1000000);
  assert.deepEqual(retain(idle, null, 1015000), { rows: [], at: 999000, state: 'stale' });
});
test('a successful empty failure poll reads as zero only while router liveness is fresh', () => {
  assert.deepEqual(retain(null, [], 1000000, { emptyIsZero: true, liveAt: 999000 }), { rows: [], at: 1000000, state: 'ok' });
  assert.deepEqual(retain(null, [], 1000000, { emptyIsZero: true, liveAt: 600000 }), { rows: [], at: null, state: 'stale' });
  assert.deepEqual(retain(null, [], 1000000, { emptyIsZero: true }), { rows: [], at: null, state: 'stale' });
  const held = retain(null, [row(2, {}, 999)], 999000);
  assert.deepEqual(retain(held, [], 1000000, { emptyIsZero: true, liveAt: 600000 }), { ...held, state: 'stale' });
});
test('a failure flash lasts one minute past its evaluation time, not past its source sample time', () => {
  const labels = { model: 'm', api_provider: 'openai' };
  const model = modelKey(labels);
  // Evaluation time T is 1000 s; the counter's last raw sample is 980 s, 20 s earlier.
  const feed = retain(null, mc8Data.withSourceTimes([row(1, labels, 1000)], [{ labels, value: 980 }]), 1000500);
  assert.equal(feed.at, 980000);
  assert.equal(increased(feed, model, 1074000), true);
  assert.equal(increased(feed, model, 1075000), true);
  assert.equal(increased(feed, model, 1075001), false);
  assert.equal(mc8Data.windowAge(feed, model, 1074000), 74);
  assert.equal(fresh(feed, 1280000), true);
});
test('re-fetching old measurements cannot reset age or reactivate failures', () => {
  const labels = { model: 'm', api_provider: 'openai' };
  const rows = [row(1, labels, 10)];
  const good = retain(null, rows, 10000);
  assert.equal(increased(good, modelKey(labels), 10000), true);
  assert.equal(fresh(good, 310000), true);
  assert.equal(fresh(good, 310001), false);
  assert.equal(increased(good, modelKey(labels), 310001), false);
  const old = retain(good, rows, 310001);
  assert.equal(old.at, 10000);
  assert.equal(old.state, 'stale');
  assert.equal(increased(old, modelKey(labels), 310001), false);
  assert.equal(retain(old, rows, 600000).at, 10000);
  assert.equal(retain(old, [row(0, labels, 600)], 600000).state, 'ok');
});
test('failure and fallback indicators expire after one minute plus a 15-second scrape', () => {
  const labels = { model: 'm', api_provider: 'openai' };
  const rows = [row(1, labels, 10)];
  const good = retain(null, rows, 10000);
  assert.equal(increased(good, modelKey(labels), 85000), true);
  assert.equal(increased(good, modelKey(labels), 85001), false);
  const repeated = retain(good, rows, 130000);
  assert.equal(fresh(repeated, 130000), true);
  assert.equal(increased(repeated, modelKey(labels), 130000), false);
});
test('oldest sample governs freshness; missing, invalid and beyond-tolerance future times are stale', () => {
  assert.equal(retain(null, [row(1, {}, 10), row(2, {}, 400)], 400000).state, 'stale');
  for (const timestamp of [undefined, NaN, Infinity, 0, -1, 406]) {
    const feed = retain(null, [{ value: 1, labels: {}, timestamp }], 400000);
    assert.equal(feed.state, 'stale');
    assert.equal(feed.at, null);
  }
  // Five seconds ahead is clock skew: accepted, clamped to browser time, and fresh.
  assert.deepEqual(retain(null, [row(401, {}, 401)], 400000), { rows: [row(401, {}, 401)], at: 400000, state: 'ok' });
});
test('a sample a few milliseconds ahead of browser time is clamped and stays fresh', () => {
  const now = 1_700_000_000_000;
  const sample = { value: 1, labels: {}, timestamp: now / 1000 + 0.01 };
  assert.deepEqual(retain(null, [sample], now), { rows: [sample], at: now, state: 'ok' });
});
test('spend, in-flight, split TTFT and failure freshness read their raw-series sample times', () => {
  assert.equal(Q.mc8SpendSourceTime, 'max(tlast_over_time(litellm_spend_metric_total{job="llm_router"}[5m]))');
  assert.equal(Q.mc8InFlightSourceTime, 'max(tlast_over_time(litellm_in_flight_requests{job="llm_router"}[5m]))');
  assert.equal(Q.mc8TtftLocalSourceTime, `max(tlast_over_time(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router",tag_telemetry_billing_class_local="true",${H}}[5m]))`);
  assert.equal(Q.mc8TtftCloudSourceTime, `max(tlast_over_time(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router",tag_telemetry_billing_class_local!="true",${H}}[5m]))`);
  assert.equal(Q.mc8TtftLocalP95, `histogram_quantile(0.95, sum by (le) (increase(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router",tag_telemetry_billing_class_local="true",${H}}[5m])))`);
  assert.equal(Q.mc8TtftCloudP95, `histogram_quantile(0.95, sum by (le) (increase(litellm_llm_api_time_to_first_token_metric_bucket{job="llm_router",tag_telemetry_billing_class_local!="true",${H}}[5m])))`);
  assert.equal(Q.mc8VllmSourceTime, 'max by (instance) (tlast_over_time(vllm:num_requests_running[5m]))');
  assert.equal(Q.mc8LlamaSourceTime, 'max by (instance) (tlast_over_time(llamacpp:requests_processing[5m]))');
  assert.equal(Q.mc8FailuresSourceTime, 'max by (model, api_provider) (tlast_over_time(litellm_deployment_failure_responses_total{job="llm_router"}[5m]))');
  assert.equal(Q.mc8FallbacksSourceTime, 'max by (model, api_provider) (tlast_over_time(litellm_deployment_failed_fallbacks_total{job="llm_router"}[5m]))');
  // Evaluation time is fresh (1300 s) but the raw sample is 1000 s old: the reading is stale.
  const spend = (now, sourceTime) => retain(null, mc8Data.withSourceTimes([row(123.4, {}, 1300)], [{ labels: {}, value: sourceTime }]), now);
  assert.equal(spend(1_301_000, 1000).state, 'stale');
  assert.equal(spend(1_301_000, 1300).state, 'ok');
  const labels = { model: 'm', api_provider: 'openai' };
  const failures = (now, sourceTime) => retain(null, mc8Data.withSourceTimes([row(1, labels, 1300)], [{ labels, value: sourceTime }]), now);
  assert.equal(failures(1_301_000, 1000).state, 'stale');
  // The flash window still ends at the evaluation time, not at the source sample time.
  assert.equal(mc8Data.windowAge(failures(1_301_000, 1300), modelKey(labels), 1_301_000), 1);
});
test('query allow-list is generated from Q and MC8 uses standard histogram buckets', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url))), Q);
  for (const key of ['mc8TtftLocalP95', 'mc8TtftCloudP95']) {
    assert.match(Q[key], /histogram_quantile\(0\.95, sum by \(le\)/);
    assert.match(Q[key], /litellm_llm_api_time_to_first_token_metric_bucket/);
    assert.ok(Q[key].includes('api_key_alias!="litellm-internal-health-check"'));
    assert.doesNotMatch(Q[key], /accelerator/);
  }
  for (const key of ['mc8InputRate', 'mc8OutputRate']) {
    for (const bank of ['local', 'subscription', 'paid', 'free']) {
      assert.ok(Q[key].includes(`tag_telemetry_billing_class_${bank}`));
    }
    assert.match(Q[key], /sum by \(api_key_alias, team, model, api_provider,/);
    assert.match(Q[key], /_tokens_metric_total\{job="llm_router",api_key_alias!="litellm-internal-health-check"\}\[5m\]/);
  }
  for (const key of ['mc8InputRate', 'mc8OutputRate', 'mc8InputSourceTime', 'mc8OutputSourceTime', 'mc8TtftLocalP95', 'mc8TtftCloudP95', 'mc8TtftLocalSourceTime', 'mc8TtftCloudSourceTime']) {
    assert.ok(Q[key].includes('api_key_alias!="litellm-internal-health-check"'), key);
  }
});
test('spend query subtracts per-series UTC month baseline before sum, then converts dollars to cents', () => {
  // Live 2026-11-07: without the clamp, 5 reset series subtracted 39 cents from the month total.
  assert.ok(Q.mc8SpendCents.startsWith('100 * sum(clamp_min(max_over_time('));
  assert.match(Q.mc8SpendCents, /api_provider="openrouter"/);
  assert.ok(Q.mc8SpendCents.includes('(scalar(day_of_month()) - 1) * 86400 - time() % 86400'));
  assert.match(Q.mc8SpendCents, /or max_over_time\(.+\[31d\]\) \* 0\), 0\)\)$/);
});
test('switchboard follows MC7 in default slides', () => {
  const source = readFileSync(new URL('../site/rotator/rotator.js', import.meta.url), 'utf8');
  assert.match(source, /url: '\/mc7\/' \},\s*\{ name: 'SWITCHBOARD', url: '\/mc8\/'/);
});
test('token-rate source times are raw-counter tlast values grouped exactly like their rate readings', () => {
  const group = (expr) => expr.match(/^(?:sum|max) by \(([^)]*)\)/)[1];
  for (const [rate, source, metric] of [
    ['mc8InputRate', 'mc8InputSourceTime', 'litellm_input_tokens_metric_total'],
    ['mc8OutputRate', 'mc8OutputSourceTime', 'litellm_output_tokens_metric_total'],
  ]) {
    assert.equal(Q[source], `max by (${group(Q[rate])}) (tlast_over_time(${metric}{job="llm_router",api_key_alias!="litellm-internal-health-check"}[5m]))`);
  }
});
test('token-rate freshness follows each raw counter sample time, not the evaluation time', () => {
  const labels = { model: 'm', api_provider: 'openai', ...billing('local') };
  const timed = mc8Data.withSourceTimes([row(4, labels, 1000)], [{ labels, value: 1000 }]);
  assert.equal(timed[0].timestamp, 1000);
  assert.equal(mc8Data.retain(null, timed, 1_299_000).state, 'ok');
  const old = mc8Data.retain(null, timed, 1_301_000);
  assert.equal(old.state, 'stale');
  assert.equal(old.at, 1_000_000);
  assert.equal(mc8Data.retain(null, mc8Data.withSourceTimes([row(4, labels, 1000)], []), 1_000_000).state, 'stale');
});
test('unclassified share carries its own stale state, independent of local share availability', () => {
  const labels = { model: 'm', api_provider: 'openai' };
  const input = (now) => mc8Data.retain(null, mc8Data.withSourceTimes([row(10, labels, 1000)], [{ labels, value: 1000 }]), now);
  const graph = shapeRates([row(10, labels)], [row(0, labels)]);
  assert.equal(graph.localShare, null);
  assert.equal(graph.unclassifiedShare, 100);
  assert.equal(mc8Data.shareState(input(1_299_000), input(1_299_000), 1_299_000), 'ok');
  assert.equal(mc8Data.shareState(input(1_301_000), input(1_301_000), 1_301_000), 'stale');
  assert.equal(mc8Data.shareState(mc8Data.retain(null, [], 1), input(1_000), 1_000), 'pending');
});
test('the spend reading states beside it that a counter reset can undercount month-to-date spend', () => {
  const html = readFileSync(new URL('../site/mc8/index.html', import.meta.url), 'utf8');
  const spend = html.match(/<article data-panel="spend"[\s\S]*?<\/article>/)[0];
  assert.match(spend, /<p class="reset-note">Counter resets can undercount month-to-date spend\.<\/p>/);
});
test('a failure flash names its window once that window ended more than 25 seconds ago', () => {
  const labels = { model: 'm', api_provider: 'openai' };
  const feed = retain(null, [row(1, labels, 100)], 100000);
  assert.equal(mc8Data.windowAge(feed, modelKey(labels), 110000), 10);
  assert.equal(mc8Data.windowLabel(10), 'last minute');
  assert.equal(mc8Data.windowAge(feed, modelKey(labels), 170000), 70);
  assert.equal(mc8Data.windowLabel(70), 'window ended 70s ago');
  assert.equal(mc8Data.windowAge(feed, modelKey({ model: 'other', api_provider: 'openai' }), 170000), null);
});
test('a hung poll request resolves null after the ten second bound and clears its timer', async (t) => {
  const delays = [];
  let cleared = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); Promise.resolve().then(callback); return 7; });
  t.mock.method(globalThis, 'clearTimeout', () => { cleared += 1; });
  assert.equal(await mc8Data.bounded(new Promise(() => {})), null);
  assert.deepEqual(delays, [10_000]);
  assert.equal(cleared, 1);
  assert.equal(await mc8Data.bounded(Promise.resolve(5)), 5);
});
test('the poll interval is at least one second and falls back to fifteen seconds when missing or invalid', () => {
  for (const config of [{}, { refreshSeconds: 'soon' }, { refreshSeconds: 0 }, { refreshSeconds: -5 }]) {
    assert.equal(mc8Data.refreshMs(config), 15_000);
  }
  assert.equal(mc8Data.refreshMs({ refreshSeconds: 0.2 }), 1000);
  assert.equal(mc8Data.refreshMs({ refreshSeconds: 1 }), 1000);
  assert.equal(mc8Data.refreshMs({ refreshSeconds: 30 }), 30_000);
});
