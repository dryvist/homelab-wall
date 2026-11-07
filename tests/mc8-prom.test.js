import test from 'node:test';
import assert from 'node:assert/strict';
import { Q } from '../site/lib/queries.js';
import { retain, increased, modelKey } from '../site/mc8/data.js';

for (const snapshot of [false, true]) {
  test(`${snapshot ? 'snapshot' : 'live'} queries preserve sample time only when requested`, async () => {
    const originalFetch = globalThis.fetch;
    const labels = { model: 'model-a', api_provider: 'openai' };
    const result = [{ metric: labels, value: [10, '1'] }];
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(url);
      if (url === '/config.json') return Response.json(snapshot ? { snapshot: '/snapshot.json' } : {});
      if (url === '/snapshot.json') return Response.json({
        generated_at: new Date().toISOString(), instant: { mc8Failures: { result } },
      });
      return Response.json({ status: 'success', data: { result } });
    };
    try {
      const { query } = await import(`../site/lib/prom.js?mc8-test=${snapshot}`);
      assert.deepEqual(await query(Q.mc8Failures), [{ labels, value: 1 }]);
      const rows = await query(Q.mc8Failures, { timestamps: true });
      assert.deepEqual(rows, [{ labels, value: 1, timestamp: 10 }]);
      const first = retain(null, rows, 10000);
      const expired = retain(first, await query(Q.mc8Failures, { timestamps: true }), 130000);
      assert.equal(expired.at, 10000);
      assert.equal(increased(expired, modelKey(labels), 130000), false);
      const repeated = retain(first, await query(Q.mc8Failures, { timestamps: true }), 400000);
      assert.equal(repeated.at, 10000);
      assert.equal(repeated.state, 'stale');
      assert.equal(increased(repeated, modelKey(labels), 400000), false);
      if (snapshot) assert.ok(requests.every((url) => !url.startsWith('/api/prom')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
