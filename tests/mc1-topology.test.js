import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopologyHubs, formatMbps } from '../site/lib/mc1Metrics.js';

const row = (network, value, vlan = 'vlan-a') => ({ labels: { network, vlan }, value });

test('topology aggregates network traffic, matches normalized groups, and retains unmatched groups', () => {
  const groups = [
    { name: 'alpha_net', apps: ['app-a'], c: '#123456' },
    { name: 'unmatched', apps: ['app-b'], c: '#654321' },
  ];
  const hubs = buildTopologyHubs(groups, [row('AlphaNet', 1), row('AlphaNet', 2)], [row('AlphaNet', 4), row('other', 5)]);

  assert.deepEqual(hubs.map(({ key }) => key), ['network:AlphaNet|vlan-a', 'network:other|vlan-a', 'group:unmatched']);
  assert.deepEqual(hubs[0], {
    key: 'network:AlphaNet|vlan-a', name: 'AlphaNet · VLAN vlan-a', isNetwork: true, hasGroup: true, apps: ['app-a'],
    color: '#123456', rxBytes: 3, txBytes: 4,
  });
  assert.equal(hubs[1].hasGroup, false);
  assert.equal(hubs[2].isNetwork, false);
});

test('unmeasured networks do not create hubs and rates convert bytes per second to Mbps', () => {
  assert.deepEqual(buildTopologyHubs([{ name: 'group', apps: [], c: '#fff' }], [], []), [
    { key: 'group:group', name: 'group', isNetwork: false, hasGroup: true, apps: [], color: '#fff', rxBytes: null, txBytes: null },
  ]);
  assert.equal(formatMbps(125000), '1.0');
  assert.equal(formatMbps(null), '—');
});

test('topology keeps two VLANs that share a network name apart', () => {
  const hubs = buildTopologyHubs([], [row('net', 1, '10'), row('net', 2, '20'), { labels: { network: 'plain' }, value: 3 }], []);
  assert.deepEqual(hubs.map(({ name, rxBytes }) => [name, rxBytes]), [['net · VLAN 10', 1], ['net · VLAN 20', 2], ['plain', 3]]);
});
