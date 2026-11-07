import assert from 'node:assert/strict';
import test from 'node:test';
import { guardRefresh } from '../site/lib/refresh.js';

test('guardRefresh skips an overlapping call and releases after success', async () => {
  let calls = 0;
  let finish;
  const guarded = guardRefresh(async () => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return calls;
  });

  const first = guarded();
  assert.equal(await guarded(), undefined);
  assert.equal(calls, 1);
  finish('complete');
  assert.equal(await first, 'complete');
  assert.equal(await guarded(), 2);
});

test('guardRefresh releases after the refresh throws', async () => {
  let calls = 0;
  const guarded = guardRefresh(async () => {
    calls += 1;
    if (calls === 1) throw new Error('refresh failed');
    return 'recovered';
  });

  await assert.rejects(guarded(), /refresh failed/);
  assert.equal(await guarded(), 'recovered');
});
