import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageRows, formatStorageBytes } from '../site/lib/mc1Metrics.js';

const zfs = (host, device, size) => ({ labels: { instance: `${host}.example.test:9100`, device, fstype: 'zfs' }, value: size });
const avail = (host, device, value, mountpoint) => ({ labels: { instance: `${host}.example.test:9100`, device, mountpoint }, value });
const pve = (host, storage, value) => ({ labels: { id: `storage/${host}/${storage}` }, value });

test('ZFS pools sum referenced dataset bytes, use maximum free, and keep the larger Proxmox usage', () => {
  const { rows, incomplete } = buildStorageRows(
    [zfs('node-a', 'pool-a/root', 10e12), zfs('node-a', 'pool-a/child', 5e12)],
    [avail('node-a', 'pool-a/root', 4e12), avail('node-a', 'pool-a/child', 1e12)],
    [pve('node-a', 'pool-a', 12e12)],
  );
  assert.deepEqual(rows, [{ host: 'node-a', name: 'pool-a', size: 16e12, used: 12e12, free: 4e12, refSum: 10e12 }]);
  assert.equal(incomplete, false);
});

test('the default root pool combines both matching storage readings', () => {
  const { rows } = buildStorageRows(
    [zfs('node-a', 'rpool/root', 4e12)],
    [avail('node-a', 'rpool/root', 3e12)],
    [pve('node-a', 'local', 1.2e12), pve('node-a', 'local-zfs', 1.4e12)],
  );
  assert.equal(rows[0].used, 2.6e12);
  assert.equal(rows[0].size, 5.6e12);
});

test('failed Proxmox storage data falls back to referenced bytes and marks totals incomplete', () => {
  const { rows, incomplete } = buildStorageRows(
    [zfs('node-a', 'pool-a/root', 10e12)], [avail('node-a', 'pool-a/root', 4e12)], null, true,
  );
  assert.equal(rows[0].used, 6e12);
  assert.equal(rows[0].size, 10e12);
  assert.equal(incomplete, true);
});

test('non-ZFS rows retain their filesystem formula and byte formatting rounds the near-terabyte range', () => {
  const { rows } = buildStorageRows(
    [{ labels: { instance: 'node-a.example.test:9100', device: '/dev/data', mountpoint: '/data', fstype: 'ext4' }, value: 1e12 }],
    [{ labels: { instance: 'node-a.example.test:9100', device: '/dev/data', mountpoint: '/data' }, value: 200e9 }],
    [],
  );
  assert.equal(rows[0].used, 800e9);
  assert.equal(formatStorageBytes(899e9), '899G');
  assert.equal(formatStorageBytes(900e9), '1T');
  assert.equal(formatStorageBytes(999e9), '1T');
  assert.equal(formatStorageBytes(1e12), '1T');
  assert.equal(formatStorageBytes(1.1e12), '1.1T');
});
