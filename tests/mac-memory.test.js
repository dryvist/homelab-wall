import test from 'node:test';
import assert from 'node:assert/strict';
import { hostValues, macReadings, modelMemoryRows } from '../site/lib/macMemory.js';

const row = (instance, value, extra = {}) => ({ labels: { instance, ...extra }, value });

test('Mac readings combine the series per host and derive RAM percent', () => {
  const readings = macReadings({
    ramUsed: [row('mac-a.example.test:9100', 96e9)],
    ramTotal: [row('mac-a.example.test:9100', 128e9)],
    swapUsed: [row('mac-a.example.test:9100', 3.5e9)],
    swapTotal: [row('mac-a.example.test:9100', 16e9)],
    pressure: [row('mac-a.example.test:9100', 42)],
  });

  assert.deepEqual(readings.get('mac-a'), {
    ram: 96e9, ramTotal: 128e9, mem: 75, swap: 3.5e9, swapTotal: 16e9, pressure: 42,
  });
});

test('a host with no Mac series has no reading, so its card holds or stays pending', () => {
  const readings = macReadings({ ramUsed: [], ramTotal: null, swapUsed: undefined, swapTotal: [], pressure: [] });
  assert.equal(readings.size, 0);
  assert.equal(readings.has('mac-a'), false);
});

test('a host missing its RAM total reports no RAM percent rather than dividing by nothing', () => {
  const readings = macReadings({ ramUsed: [row('mac-a.example.test:9100', 8e9)], ramTotal: [], swapUsed: [], swapTotal: [], pressure: [] });
  assert.equal(readings.get('mac-a').mem, null);
  assert.equal(readings.get('mac-a').ram, 8e9);
});

test('non-finite values are treated as absent', () => {
  assert.equal(hostValues([row('mac-a.example.test:9100', Number.NaN)]).size, 0);
});

test('model memory rows are per host and model, largest first, with a share of host RAM', () => {
  const ramTotals = new Map([['mac-a', 128e9]]);
  const rows = modelMemoryRows([
    row('mac-a.example.test:9100', 21e9, { model: 'model-coder' }),
    row('mac-a.example.test:9100', 58e9, { model: 'mlx-community/model-large' }),
    row('mac-a.example.test:9100', 4e9, {}),
  ], ramTotals);

  assert.deepEqual(rows.map((r) => [r.host, r.model, r.bytes]), [
    ['mac-a', 'mlx-community/model-large', 58e9],
    ['mac-a', 'model-coder', 21e9],
  ]);
  assert.equal(rows[0].share, (100 * 58e9) / 128e9);
});

test('model memory with no known host RAM total has no share, and no series yields no rows', () => {
  const rows = modelMemoryRows([row('mac-a.example.test:9100', 9e9, { model: 'model-small' })], new Map());
  assert.equal(rows[0].share, null);
  assert.deepEqual(modelMemoryRows(undefined, new Map()), []);
  assert.deepEqual(modelMemoryRows([], new Map()), []);
});
