import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityRing, shapeNodes, ageLabel, refreshNode, withTimeout } from '../site/mc9/model.js';
import { Q } from '../site/lib/queries.js';

const now = 90000;
const feed = (rate, values = [], timestamp = now) => ({ mc9CodexRate: {
  current: [{ labels: {}, value: rate, timestamp }, { labels: { backend: 'subagents' }, value: 2, timestamp }],
  history: [{ labels: {}, values }],
  historyAt: now,
} });
const codex = (nodes) => nodes.find((n) => n.id === 'codex');
const byId = (nodes, id) => nodes.find((n) => n.id === id);

test('an empty feed is pending, never zero or an invented activity time', () => {
  for (const node of shapeNodes({}, [], now).filter((n) => n.signal)) {
    assert.equal(node.rate, null);
    assert.equal(node.lastActive, null);
    assert.equal(node.state, 'pending');
    assert(node.ring.every((v) => v === null));
  }
});

test('positive, zero, and invalid measurements remain distinct', () => {
  const active = shapeNodes(feed(3), [], now);
  assert.equal(codex(active).state, 'active');
  assert.equal(codex(active).lastActive, now);
  assert.equal(active.find((n) => n.id === 'codex-subagents').rate, 2);
  const idle = codex(shapeNodes(feed(0, [[now - 600, 3], [now - 300, 0]]), [], now));
  assert.equal(idle.state, 'idle');
  assert.equal(idle.lastActive, now - 600);
  for (const value of [NaN, Infinity, -1, null, '3']) {
    assert.equal(codex(shapeNodes(feed(value), [], now)).state, 'pending');
  }
});

test('missing and failed polls keep the last real rate and observation age', () => {
  const good = shapeNodes(feed(3), [], now);
  const stale = codex(shapeNodes({ mc9CodexRate: { current: null } }, good, now + 100));
  assert.equal(stale.state, 'stale');
  assert.equal(stale.rate, 3);
  assert.equal(stale.seenAt, now);
  assert.equal(stale.lastActive, now);
  assert.equal(codex(shapeNodes(feed(0, [], now + 100), good, now + 100)).state, 'idle');
});

test('results stamped slightly ahead of the client clock still count, clamped to now', () => {
  const ahead = codex(shapeNodes(feed(3, [], now + 0.6), [], now));
  assert.equal(ahead.state, 'active');
  assert.equal(ahead.seenAt, now);
  assert.equal(codex(shapeNodes(feed(3, [], now + 10), [], now)).state, 'pending');
});

test('24h rings preserve real zeros, missing bins, and chronological position', () => {
  const ring = activityRing([[now - 600, 4], [now - 300, 0], [now, 2], [now - 90000, 7], [now + 600, 9], [now - 1200, NaN]], now);
  assert.equal(ring.length, 288);
  assert.deepEqual(ring.slice(-4), [null, 4, 0, 2]);
  assert.equal(ring.filter((v) => v !== null).length, 3);
});

test('unaligned sample timestamps stay in their own five-minute bins', () => {
  const ring = activityRing([[89560, 4], [89860, 0], [90160, 2]], 90160);
  assert.deepEqual(ring.slice(-3), [4, 0, 2]);
  assert.equal(ring.filter((v) => v !== null).length, 3);
});

test('repeated old measurements retain their source age and become stale', () => {
  for (const rate of [3, 0]) {
    const data = feed(rate, [], now - 3600);
    const first = shapeNodes(data, [], now);
    const node = codex(shapeNodes(data, first, now + 15));
    assert.equal(node.state, 'stale');
    assert.equal(node.seenAt, now - 3600);
    assert.equal(node.lastActive, rate > 0 ? now - 3600 : null);
    assert.equal(node.rate, rate);
    if (rate > 0) assert.equal(ageLabel(node.lastActive, now), '1h ago');
  }
  assert.equal(codex(shapeNodes(feed(3, [], now - 300), [], now)).state, 'active');
  assert.equal(codex(shapeNodes(feed(3, [], now - 301), [], now)).state, 'stale');
  for (const timestamp of [undefined, NaN, Infinity, -1, now + 10]) {
    const data = feed(3);
    data.mc9CodexRate.current[0].timestamp = timestamp;
    assert.equal(codex(shapeNodes(data, [], now)).state, 'pending');
  }
});

test('metric identity labels and unexpected role values never become node names', () => {
  const data = feed(1);
  data.mc9CodexRate.current.push({ labels: { backend: 'private-identity', session_id: 'private-session', user_id: 'private-user' }, value: 999 });
  const nodes = shapeNodes(data, [], now);
  assert.equal(codex(nodes).rate, 1);
  assert(!JSON.stringify(nodes).includes('private-'));
});

test('render-time freshness expires active and idle states without a completed poll', () => {
  for (const rate of [3, 0]) {
    const node = codex(shapeNodes(feed(rate), [], now));
    assert.equal(refreshNode(node, now + 300).state, rate ? 'active' : 'idle');
    const stale = refreshNode(node, now + 301);
    assert.equal(stale.state, 'stale');
    assert.equal(stale.rate, rate);
    assert.equal(stale.seenAt, now);
  }
});

test('history status follows in-window samples and the history fetch age between polls', () => {
  const node = codex(shapeNodes(feed(3, [[now, 0]]), [], now));
  assert.equal(node.historyPending, false);
  assert.equal(node.historyStale, false);
  const delayed = refreshNode(node, now + 601);
  assert.equal(delayed.historyPending, false);
  assert.equal(delayed.historyStale, true);
  const expired = refreshNode(node, now + 86400);
  assert(expired.ring.every((v) => v === null));
  assert.equal(expired.historyPending, true);
  assert.equal(expired.historyStale, true);
  const empty = codex(shapeNodes(feed(3), [], now));
  assert.equal(empty.historyPending, true);
  assert.equal(empty.historyStale, false);
});

test('a series that went quiet keeps current history while the history fetch is current', () => {
  const quiet = { mc9CodexRate: {
    current: [{ labels: {}, value: 3, timestamp: now }],
    history: [{ labels: { backend: 'subagents' }, values: [[now - 720, 5]] }],
    historyAt: now,
  } };
  const node = byId(shapeNodes(quiet, [], now), 'codex-subagents');
  assert.equal(node.historyStale, false);
  assert.equal(node.lastActive, now - 720);
  assert.equal(refreshNode(node, now + 601).historyStale, true);
});

test('a satellite without its own row reads zero at the parent sample time while the parent reports', () => {
  const parent = (timestamp) => [{ labels: {}, value: 3, timestamp }];
  const idle = byId(shapeNodes({ mc9CodexRate: { current: parent(now - 20) } }, [], now), 'codex-subagents');
  assert.deepEqual([idle.state, idle.rate, idle.seenAt], ['idle', 0, now - 20]);
  // A satellite that just finished reads zero, not its last rate turning stale.
  const busy = shapeNodes(feed(3), [], now);
  assert.equal(byId(busy, 'codex-subagents').rate, 2);
  const done = byId(shapeNodes({ mc9CodexRate: { current: parent(now + 390) } }, busy, now + 400), 'codex-subagents');
  assert.deepEqual([done.state, done.rate, done.lastActive], ['idle', 0, now]);
  // A stale parent makes the inferred zero stale too.
  assert.equal(byId(shapeNodes({ mc9CodexRate: { current: parent(now - 400) } }, [], now), 'codex-subagents').state, 'stale');
  // A failed poll, or no reporting parent, is no evidence of idleness.
  assert.equal(byId(shapeNodes({ mc9CodexRate: { current: null } }, [], now), 'codex-subagents').state, 'pending');
  assert.equal(byId(shapeNodes({ mc9CodexRate: { current: [] } }, [], now), 'codex-subagents').state, 'pending');
  // A satellite with its own query takes the parent's separate feed.
  const claude = { mc9ClaudeMainRate: { current: [{ labels: {}, value: 1, timestamp: now }] }, mc9ClaudeSubagentRate: { current: [] } };
  assert.equal(byId(shapeNodes(claude, [], now), 'claude-subagents').state, 'idle');
  assert.equal(byId(shapeNodes({ mc9ClaudeSubagentRate: { current: [] } }, [], now), 'claude-subagents').state, 'pending');
  assert.equal(byId(shapeNodes({}, [], now), 'cron').state, 'pending');
  const hermes = { mc9GatewayAgents: { current: [{ labels: {}, value: 2, timestamp: now }] }, mc9CronJobs: { current: [] } };
  assert.equal(byId(shapeNodes(hermes, [], now), 'gateway').state, 'active');
  // A running-jobs gauge reports zero itself, so its absence is not zero.
  assert.equal(byId(shapeNodes(hermes, [], now), 'cron').state, 'pending');
  hermes.mc9CronJobs.current = [{ labels: {}, value: 0, timestamp: now }];
  assert.equal(byId(shapeNodes(hermes, [], now), 'cron').state, 'idle');
});

test('a hung request times out while fulfilled and rejected requests keep their result', { timeout: 1000 }, async () => {
  const hung = withTimeout(new Promise(() => {}), 5);
  const rejected = assert.rejects(hung, /timed out/);
  await rejected;
  assert.equal(await withTimeout(Promise.resolve(3)), 3);
  await assert.rejects(withTimeout(Promise.reject(new Error('failed'))), /failed/);
});

test('age labels do not invent last activity outside the observed window', () => {
  assert.equal(ageLabel(null, now), 'not observed');
  assert.equal(ageLabel(now - 120, now), '2m ago');
  assert.equal(ageLabel(now - 7200, now), '2h ago');
});

test('generated allow-list matches Q, including the MC9 queries', () => {
  const generated = JSON.parse(readFileSync(new URL('../site/queries.json', import.meta.url)));
  assert.deepEqual(generated, Q);
  assert.equal(Q.mc9DonnaRate, 'sum(rate(litellm_proxy_total_requests_metric_total{api_key_alias="donna"}[5m]))');
  assert(Q.mc9CodexRate.includes('session_source'));
  assert(Q.mc9ClaudeMainRate.includes('agent_name=~"main|"'));
  assert(Q.mc9ClaudeSubagentRate.includes('agent_name!~"main|"'));
  assert.equal(Q.mc9ClaudeMainRate, 'sum(rate(claude_code_token_usage_total{type="output",agent_name=~"main|"}[5m]))');
  assert.equal(Q.mc9ClaudeSubagentRate, 'sum(rate(claude_code_token_usage_total{type="output",agent_name!~"main|"}[5m]))');
  assert(Q.mc9GatewayAgents.includes('hermes_gateway_active_agents'));
  assert(Q.mc9CronJobs.includes('hermes_cron_jobs_running'));
  assert.equal(Q.mc9SpanRate, undefined);
  for (const [key, expr] of Object.entries(Q).filter(([key]) => key.startsWith('mc9'))) {
    assert(!expr.includes('or vector(0)'), key);
    assert(!/by \([^)]*(session_id|user_id|instance)/.test(expr), key);
  }
});
