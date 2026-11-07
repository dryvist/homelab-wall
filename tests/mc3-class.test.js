import test from 'node:test';
import assert from 'node:assert/strict';
import { splitByClass } from '../site/lib/mc3.js';

test('splitByClass separates exact local names and preserves model order', () => {
  const models = [{ n: 'model-a' }, { n: 'model-b' }, { n: 'model-c' }];
  const split = splitByClass(models, new Set(['model-b']));

  assert.deepEqual(split, { local: [{ n: 'model-b' }], cloud: [{ n: 'model-a' }, { n: 'model-c' }] });
  assert.deepEqual(models, [{ n: 'model-a' }, { n: 'model-b' }, { n: 'model-c' }]);
});
