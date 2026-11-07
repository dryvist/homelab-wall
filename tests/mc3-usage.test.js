import assert from 'node:assert/strict';
import test from 'node:test';
import { billingClassValues, classPair, modelCounts, modelCountPair } from '../site/lib/mc3.js';

const row = (value, labels = {}) => ({ value, labels });

test('usage sums local and cloud classes independently, including unlabeled cloud rows', () => {
  assert.deepEqual(billingClassValues([
    row(4, { tag_telemetry_billing_class_local: 'true' }),
    row(3, { tag_telemetry_billing_class_local: 'false' }),
    row(2),
  ]), { local: 4, cloud: 5 });
  assert.deepEqual(billingClassValues([row(0, { tag_telemetry_billing_class_local: 'true' })]), { local: 0, cloud: null });
  assert.deepEqual(billingClassValues(null), { local: null, cloud: null });
});

test('model counts use only the local-model query and preserve an unknown classification', () => {
  const models = [{ n: 'model-a', up: true }, { n: 'model-b', up: false }, { n: 'model-c', up: true }];
  assert.deepEqual(modelCounts(models, [row(1, { model: 'model-a' })]), {
    local: { up: 1, total: 1 }, cloud: { up: 1, total: 2 },
  });
  assert.equal(modelCounts(models, null), null);
  assert.deepEqual(modelCounts(models, []), { local: { up: 0, total: 0 }, cloud: { up: 2, total: 3 } });
});

test('split display values keep each missing side visible as an em dash', () => {
  assert.equal(classPair(12, null, (value) => String(value)), 'local 12 · cloud —');
  assert.equal(modelCountPair(null, true), 'local — · cloud — UP');
});
