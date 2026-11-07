import test from 'node:test';
import assert from 'node:assert/strict';
import { retain, feedValue, ZERO_WHEN_EMPTY, IDLE_WHEN_EMPTY } from '../site/mc8/data.js';

test('a failed poll after a stale reading with no measurement time stays stale', () => {
  const unknown = retain(null, [], 1000000, { emptyIsZero: true });
  assert.deepEqual(unknown, { rows: [], at: null, state: 'stale' });
  assert.deepEqual(retain(unknown, null, 1015000, { emptyIsZero: true }), unknown);
  assert.deepEqual(retain(unknown, [], 1015000), unknown);
  assert.equal(retain(null, null, 1000000).state, 'pending');
});

test('an empty spend poll reads zero cents only while router liveness is fresh', () => {
  assert.ok(ZERO_WHEN_EMPTY.has('mc8SpendCents'));
  const live = retain(null, [], 1000000, { emptyIsZero: ZERO_WHEN_EMPTY.has('mc8SpendCents'), liveAt: 999000 });
  assert.equal(live.state, 'ok');
  assert.equal(feedValue(live), 0);
  const dead = retain(null, [], 1000000, { emptyIsZero: true, liveAt: 600000 });
  assert.equal(dead.state, 'stale');
  assert.equal(feedValue(dead), null);
});

test('a feed value is its first row, and null while unmeasured or idle', () => {
  const measured = retain(null, [{ labels: {}, value: 164.77, timestamp: 999 }], 1000000);
  assert.equal(feedValue(measured), 164.77);
  assert.equal(feedValue(retain(null, null, 1000000)), null);
  assert.equal(feedValue(retain(null, [{ labels: {}, value: NaN, timestamp: 999 }], 1000000)), null);
  assert.equal(feedValue(undefined), null);
});

test('an empty TTFT poll is idle only while its own source time is fresh', () => {
  assert.ok(IDLE_WHEN_EMPTY.has('mc8TtftLocalP95'));
  assert.ok(IDLE_WHEN_EMPTY.has('mc8TtftCloudP95'));
  const idle = retain(null, [], 1000000, { idleAt: 990000 });
  assert.deepEqual(idle, { rows: [], at: 990000, state: 'idle' });
  assert.equal(feedValue(idle), null);
  // Up to 5 s ahead is clamped to now; an old, missing or far-future source time is no evidence.
  assert.deepEqual(retain(null, [], 1000000, { idleAt: 1004000 }), { rows: [], at: 1000000, state: 'idle' });
  for (const idleAt of [600000, NaN, null, 1010000]) assert.equal(retain(null, [], 1000000, { idleAt }).state, 'pending');
  // A held reading gives way to idle on a successful empty poll; a failed poll keeps it stale.
  const held = retain(null, [{ labels: {}, value: 0.4, timestamp: 999 }], 1000000);
  assert.deepEqual(retain(held, [], 1015000, { idleAt: 1014000 }), { rows: [], at: 1014000, state: 'idle' });
  assert.deepEqual(retain(held, null, 1015000, { idleAt: 1014000 }), { ...held, state: 'stale' });
});
