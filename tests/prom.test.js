import assert from 'node:assert/strict';
import test from 'node:test';
import { Q } from '../site/lib/queries.js';

const labels = { model: 'test-model' };
const captured = 1_700_000_000;
const instant = [{ metric: labels, value: [captured, '12.5'] }];
const matrix = [{ metric: labels, values: [[captured - 30, '10'], [captured, '12.5']] }];
const pairs = [[captured - 30, 10], [captured, 12.5]];

async function client(t, source) {
  let now = (captured + 137) * 1000 + 750;
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    if (url === '/config.json') {
      return Response.json(source === 'snapshot' ? { snapshot: '/data/snapshot.json' } : {});
    }
    if (url === '/data/snapshot.json') {
      return Response.json({
        generated_at: new Date(now).toISOString(),
        instant: { nodeCpu: { result: instant } },
        range: { nodeCpu: { result: matrix } },
      });
    }
    const path = new URL(url, 'https://wall.example.test').pathname;
    assert.ok(['/api/prom/query', '/api/prom/query_range'].includes(path));
    return Response.json({ status: 'success', data: { result: path.endsWith('query') ? instant : matrix } });
  });
  const prom = await import(`../site/lib/prom.js?test=${encodeURIComponent(t.name)}`);
  return { ...prom, requests, advance: () => { now += 60_000; } };
}

for (const source of ['live', 'snapshot']) {
  test(`${source}: omitted and false options preserve the exact default shapes`, async (t) => {
    const prom = await client(t, source);
    for (const opts of [undefined, {}, { timestamps: false, align: false }]) {
      assert.deepEqual(await prom.query(Q.nodeCpu, opts), [{ labels, value: 12.5 }]);
      assert.deepEqual(await prom.range(Q.nodeCpu, 5, 30, opts), [{ labels, values: [10, 12.5] }]);
    }
    if (source === 'live') {
      const params = new URL(prom.requests.at(-1), 'https://wall.example.test').searchParams;
      assert.equal(params.get('end'), String(captured + 137));
      assert.equal(params.get('start'), String(captured + 137 - 300));
      assert.equal(params.get('step'), '30');
      assert.equal(params.get('query'), Q.nodeCpu);
    } else {
      assert.deepEqual(prom.requests, ['/config.json', '/data/snapshot.json']);
    }
  });

  test(`${source}: timestamps preserve source times through a later poll`, async (t) => {
    const prom = await client(t, source);
    for (let poll = 0; poll < 2; poll += 1) {
      assert.deepEqual(await prom.query(Q.nodeCpu, { timestamps: true }), [
        { labels, value: 12.5, timestamp: captured },
      ]);
      assert.deepEqual(await prom.range(Q.nodeCpu, 5, 30, { timestamps: true }), [{ labels, values: pairs }]);
      prom.advance();
    }
    if (source === 'snapshot') {
      assert.deepEqual(prom.requests, ['/config.json', '/data/snapshot.json', '/data/snapshot.json']);
    }
  });

  test(`${source}: alignment is independent of timestamp output`, async (t) => {
    const prom = await client(t, source);
    for (const timestamps of [false, true]) {
      assert.deepEqual(await prom.range(Q.nodeCpu, 5, 30, { align: true, timestamps }), [
        { labels, values: timestamps ? pairs : [10, 12.5] },
      ]);
    }
    if (source === 'live') {
      const params = new URL(prom.requests.at(-1), 'https://wall.example.test').searchParams;
      const end = Math.floor((captured + 137) / 30) * 30;
      assert.equal(params.get('end'), String(end));
      assert.equal(params.get('start'), String(end - 300));
      assert.equal(params.get('step'), '30');
    } else {
      // Alignment only sets live request bounds; captured samples are never retimed.
      assert.deepEqual(prom.requests, ['/config.json', '/data/snapshot.json']);
    }
  });
}
