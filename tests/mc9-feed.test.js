import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Q } from '../site/lib/queries.js';
import { activityRing, shapeNodes } from '../site/mc9/model.js';

const samples = [[1000, '0'], [1600, '4']];

test('MC9 range endpoints align with the ring and keep the newest sample', async (t) => {
  t.mock.method(Date, 'now', () => 90160000);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/config.json') return Response.json({});
    const params = new URL(String(url), 'https://example.test').searchParams;
    assert.equal(Number(params.get('end')), 90000);
    assert.equal(Number(params.get('start')), 3600);
    assert.equal(Number(params.get('step')), 300);
    return Response.json({ status: 'success', data: { result: [{ metric: {}, values: [[90000, '2']] }] } });
  });
  const { range } = await import('../site/lib/prom.js?mc9-aligned-test');
  const rows = await range(Q.mc9DonnaRate, 1440, 300, { timestamps: true, align: true });
  assert.equal(activityRing(rows[0].values, 90160).at(-1), 2);
});

for (const snapshot of [false, true]) {
  test(`${snapshot ? 'snapshot' : 'live'} instant timestamps are optional and MC9 uses measurement age`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (url === '/config.json') return Response.json(snapshot ? { snapshot: '/snapshot.json' } : {});
      const result = [{ metric: {}, value: [86400, '3'] }];
      return Response.json(snapshot ? { instant: { mc9DonnaRate: { result } } }
        : { status: 'success', data: { result } });
    });
    const { query } = await import(`../site/lib/prom.js?mc9-instant-${snapshot}`);
    assert.deepEqual(await query(Q.mc9DonnaRate), [{ labels: {}, value: 3 }]);
    const current = await query(Q.mc9DonnaRate, { timestamps: true });
    assert.deepEqual(current, [{ labels: {}, value: 3, timestamp: 86400 }]);
    const node = shapeNodes({ mc9DonnaRate: { current } }, [], 90000).find((n) => n.id === 'donna');
    assert.equal(node.state, 'stale');
    assert.equal(node.lastActive, 86400);
    assert.equal(node.seenAt, 86400);
  });
}

test('range keeps timestamps and gaps when requested, preserving existing numeric callers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/config.json') return Response.json({});
    assert(String(url).startsWith('/api/prom/query_range?'));
    return Response.json({ status: 'success', data: { result: [{ metric: {}, values: samples }] } });
  });
  const { range } = await import('../site/lib/prom.js?mc9-live-test');
  assert.deepEqual(await range(Q.mc9DonnaRate, 1440, 300, { timestamps: true }), [{ labels: {}, values: [[1000, 0], [1600, 4]] }]);
  assert.deepEqual(await range(Q.mc9DonnaRate, 1440, 300), [{ labels: {}, values: [0, 4] }]);
});

test('snapshot ranges keep source timestamps instead of reconstructing a complete timeline', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/config.json') return Response.json({ snapshot: '/snapshot.json' });
    assert.equal(url, '/snapshot.json');
    return Response.json({ range: { mc9DonnaRate: { result: [{ metric: {}, values: samples }] } } });
  });
  const { range } = await import('../site/lib/prom.js?mc9-snapshot-test');
  assert.deepEqual(await range(Q.mc9DonnaRate, 1440, 300, { timestamps: true }), [{ labels: {}, values: [[1000, 0], [1600, 4]] }]);
  assert.deepEqual(await range(Q.mc9DonnaRate, 1440, 300), [{ labels: {}, values: [0, 4] }]);
});
