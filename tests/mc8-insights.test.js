import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Q } from '../site/lib/queries.js';
import { classTotals, formatPair, groupCallerRows, insightStatus, pinCallers, pinRules, topModels } from '../site/mc8/metrics.js';

const row = (value, labels = {}) => ({ value, labels });
const health = 'api_key_alias!="litellm-internal-health-check"';

test('local and cloud pairs omit missing classes and keep measured zero', () => {
  assert.equal(formatPair(12, null, ' req/min'), 'local 12 req/min');
  assert.equal(formatPair(null, 0, ' req/min'), 'cloud 0 req/min');
  assert.equal(formatPair(null, null), '—');
  assert.deepEqual(classTotals([
    row(2, { tag_telemetry_billing_class_local: 'true' }), row(3, { tag_telemetry_billing_class_local: 'false' }),
    row(4, { tag_telemetry_billing_class_paid: 'true' }), row(5, {}), row(0, { tag_telemetry_billing_class_local: 'true' }), row(NaN),
  ]), { local: 2, cloud: 12 });
});

test('top models rank up to five per class and keep all non-local billing rows in cloud', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i + 1, { model: `local-${i}`, tag_telemetry_billing_class_local: 'true' }));
  rows.push(...Array.from({ length: 7 }, (_, i) => row(i + 10, { model: `cloud-${i}`, tag_telemetry_billing_class_local: i % 2 ? 'false' : undefined })));
  rows.push(row(0, { model: 'idle', tag_telemetry_billing_class_local: 'false' }));
  const result = topModels(rows);
  assert.equal(result.local.length, 5);
  assert.equal(result.cloud.length, 5);
  assert.equal(result.local[0].name, 'local-6');
  assert.equal(result.cloud[0].name, 'cloud-6');
  assert.ok(result.cloud.every((model) => model.name.startsWith('cloud-')));
});

test('pinned callers stay visible and empty pins differ from measured zero rates', () => {
  const callers = [{ id: JSON.stringify(['active', 'team']), name: 'active', team: 'team', localRate: 0, cloudRate: null }];
  const result = pinCallers(callers, ['active', 'waiting', 'waiting']);
  assert.equal(result.length, 2);
  assert.equal(result.find((caller) => caller.name === 'active').pinned, true);
  assert.equal(result.find((caller) => caller.name === 'active').localRate, 0);
  assert.deepEqual(result.find((caller) => caller.name === 'waiting'), {
    id: JSON.stringify(['waiting', '']), name: 'waiting', team: '', localRate: null, cloudRate: null, pinned: true,
  });
  assert.deepEqual(pinCallers(callers, undefined), callers);
});

test('insight panels expose pending, live, idle, stale and error states', () => {
  const key = 'mc8RequestsPerMinute', now = 1_000_000;
  const status = (feed, errors = {}) => insightStatus([key], [key], { [key]: feed }, errors, now);
  assert.equal(status(undefined).state, 'pending');
  assert.equal(status({ rows: [row(1)], at: now, state: 'ok' }).state, 'ok');
  assert.equal(status({ rows: [], at: now, state: 'idle' }).state, 'idle');
  assert.equal(status({ rows: [row(1)], at: now - 301_000, state: 'stale' }).state, 'stale');
  assert.deepEqual(status(undefined, { [key]: 'gateway unavailable' }), { state: 'error', text: 'Error: gateway unavailable' });
});

test('query allow-list matches Q and original MC8 histogram queries exclude health checks', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url))), Q);
  for (const key of ['mc8TtftLocalP95', 'mc8TtftCloudP95']) {
    assert.match(Q[key], /histogram_quantile\(0\.95, sum by \(le\)/);
    assert.ok(Q[key].includes('litellm_llm_api_time_to_first_token_metric_bucket'));
    assert.ok(Q[key].includes(health));
  }
  for (const key of ['mc8InputRate', 'mc8OutputRate', 'mc8InputSourceTime', 'mc8OutputSourceTime']) {
    assert.ok(Q[key].includes(health), key);
  }
});

test('new switchboard queries split billing classes and exclude health checks', () => {
  assert.equal(Q.mc8RequestsPerMinute, `sum by (tag_telemetry_billing_class_local) (rate(litellm_proxy_total_requests_metric_total{job="llm_router",${health}}[5m])) * 60`);
  for (const [key, percentile, billingClass] of [
    ['mc8RequestLatencyLocalP50', '0.5', 'tag_telemetry_billing_class_local="true"'],
    ['mc8RequestLatencyCloudP50', '0.5', 'tag_telemetry_billing_class_local!="true"'],
    ['mc8RequestLatencyLocalP95', '0.95', 'tag_telemetry_billing_class_local="true"'],
    ['mc8RequestLatencyCloudP95', '0.95', 'tag_telemetry_billing_class_local!="true"'],
  ]) {
    assert.match(Q[key], new RegExp(`histogram_quantile\\(${percentile}, sum by \\(le\\) \\(increase\\(litellm_request_total_latency_metric_bucket`));
    assert.ok(Q[key].includes(billingClass)); assert.ok(Q[key].includes(health));
    assert.doesNotMatch(Q[key], /_count|_sum/);
  }
  for (const [key, metric] of [['mc8Failures15m', 'litellm_deployment_failure_responses_total'], ['mc8Fallbacks15m', 'litellm_deployment_failed_fallbacks_total']]) {
    assert.ok(Q[key].includes(`increase(${metric}{job="llm_router",${health}}[15m])`));
    assert.ok(Q[key].includes('sum by (tag_telemetry_billing_class_local)'));
  }
  for (const key of ['mc8TopModelsLocal', 'mc8TopModelsCloud']) {
    assert.match(Q[key], /topk\(5, sum by \(model, tag_telemetry_billing_class_local\)/);
    assert.ok(Q[key].includes('litellm_request_total_latency_metric_bucket{le="+Inf"'));
    assert.ok(Q[key].includes('[1h]')); assert.ok(Q[key].includes(health));
  }
  for (const key of ['mc8RequestsSourceTime', 'mc8RequestLatencyLocalSourceTime', 'mc8RequestLatencyCloudSourceTime',
    'mc8Failures15mSourceTime', 'mc8Fallbacks15mSourceTime', 'mc8TopModelsLocalSourceTime', 'mc8TopModelsCloudSourceTime']) assert.ok(Q[key].includes(health), key);
});

test('spend query subtracts per-series UTC month baseline before sum', () => {
  assert.ok(Q.mc8SpendCents.startsWith('100 * sum(clamp_min(max_over_time('));
  assert.match(Q.mc8SpendCents, /api_provider="openrouter"/);
  assert.ok(Q.mc8SpendCents.includes('(scalar(day_of_month()) - 1) * 86400 - time() % 86400'));
  assert.match(Q.mc8SpendCents, /or max_over_time\(.+\[31d\]\) \* 0\), 0\)\)$/);
});

test('switchboard follows MC7 in default slides', () => {
  const source = readFileSync(new URL('../site/rotator/rotator.js', import.meta.url), 'utf8');
  assert.match(source, /url: '\/mc7\/' \},\s*\{ name: 'SWITCHBOARD', url: '\/mc8\/'/);
});

test('the spend reading includes its counter-reset note', () => {
  const html = readFileSync(new URL('../site/mc8/index.html', import.meta.url), 'utf8');
  const spend = html.match(/<article data-panel="spend"[\s\S]*?<\/article>/)[0];
  assert.match(spend, /<p class="reset-note">Counter resets can undercount month-to-date spend\.<\/p>/);
});

test('a glob pin groups its callers into one row and an exact pin keeps its own row', () => {
  const rules = pinRules(['agent-default', { name: 'agent fleet', match: 'agent-*' }, { name: '', match: 'x' }, 7]);
  assert.deepEqual(rules.names, ['agent-default', 'agent fleet']);
  const row = (alias, team) => ({ labels: { api_key_alias: alias, team }, value: 1 });
  const grouped = groupCallerRows([row('agent-a', 't1'), row('agent-b', 't2'), row('agent-default', 't3'), row('other', 't4')], rules);
  assert.deepEqual(grouped.map((r) => [r.labels.api_key_alias, r.labels.team]), [
    ['agent fleet', ''], ['agent fleet', ''], ['agent-default', 't3'], ['other', 't4'],
  ]);
  assert.equal(pinRules([{ name: 'dots', match: 'a.b*' }]).groups[0].re.test('aXb-1'), false);
});
