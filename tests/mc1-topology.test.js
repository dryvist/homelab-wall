import test from 'node:test';
import assert from 'node:assert/strict';
import { Q } from '../site/lib/queries.js';
import { buildFirewallRows, buildTopologyModel, classifyDeviceRole, dominantAccessDevice, edgeMotion, matchNetworkGroup, namedFlowRows, normalizeNetwork } from '../site/lib/mc1Topology.js';

const row = (labels, value) => ({ labels, value });
const deviceRows = [
  row({ name: 'gw-a', model: 'gateway-a', type: 'udm' }, 1),
  row({ name: 'sw-a', model: 'switch-a', type: 'usw' }, 1),
  row({ name: 'ap-a', model: 'access-point-a', type: 'uap' }, 1),
];

test('device inventory maps UniFi types to gateway, switch, and AP roles', () => {
  assert.equal(classifyDeviceRole('udm'), 'gateway');
  assert.equal(classifyDeviceRole('ugw'), 'gateway');
  assert.equal(classifyDeviceRole('usw'), 'switch');
  assert.equal(classifyDeviceRole('uap'), 'ap');
  assert.equal(classifyDeviceRole('other'), 'unknown');
});

test('network names normalize exact matches and only the configured generic aliases', () => {
  assert.equal(normalizeNetwork('Management'), normalizeNetwork('mgmt'));
  assert.equal(matchNetworkGroup({ name: 'mgmt' }, 'Management'), true);
  for (const [alias, full] of [['svc', 'services'], ['svcs', 'services'], ['prod', 'production'], ['dev', 'development'], ['infra', 'infrastructure']]) {
    assert.equal(matchNetworkGroup({ name: alias }, full), true);
  }
  assert.equal(matchNetworkGroup({ name: 'office' }, 'office-work'), false);
});

test('group matches merge into one VLAN hub and unmatched groups remain separate', () => {
  const model = buildTopologyModel({
    groups: [{ name: 'mgmt', apps: ['app-a'], c: '#123456' }, { name: 'unmatched', apps: ['app-b'] }],
    vlanRxRows: [row({ network: 'Management', vlan: '10', sw_name: 'sw-a' }, 100)],
    vlanTxRows: [row({ network: 'Management', vlan: '10', sw_name: 'sw-a' }, 50)],
    deviceRows,
  });
  const hubs = model.nodes.filter((node) => node.type === 'vlan');
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].name, 'Management · VLAN 10');
  assert.deepEqual(hubs[0].apps, ['app-a']);
  assert.equal(hubs[0].color, '#123456');
  assert.equal(model.nodes.some((node) => node.id === 'group:mgmt'), false);
  assert.equal(model.nodes.some((node) => node.id === 'group:unmatched'), true);
});

test('empty topology metrics create no traffic, WAN node, or rate values', () => {
  const model = buildTopologyModel({ groups: [{ name: 'apps', apps: ['app-a'] }] });
  assert.deepEqual(model.nodes.map((node) => node.type), ['group']);
  assert.equal(model.nodes[0].rxBytes, null);
  assert.equal(model.nodes[0].txBytes, null);
  assert.deepEqual(model.edges, []);
  assert.deepEqual(buildFirewallRows(), { countries: [], flows: [], rules: [] });
});

test('VLAN traffic chooses the access device carrying the most combined client bytes', () => {
  const rx = [row({ network: 'net-a', vlan: '10', sw_name: 'sw-a' }, 100), row({ network: 'net-a', vlan: '10', ap_name: 'ap-a' }, 80)];
  const tx = [row({ network: 'net-a', vlan: '10', sw_name: 'sw-a' }, 20), row({ network: 'net-a', vlan: '10', ap_name: 'ap-a' }, 70)];
  assert.equal(dominantAccessDevice(rx, tx, 'net-a', '10'), 'ap-a');
  const model = buildTopologyModel({ vlanRxRows: rx, vlanTxRows: tx, deviceRows });
  const vlan = model.nodes.find((node) => node.type === 'vlan');
  assert.equal(vlan.accessDeviceId, 'device:ap-a');
  assert.equal(model.edges.find((edge) => edge.type === 'client').to, 'device:ap-a');
});

test('topology byte edges use measured client, device, and WAN rates', () => {
  const model = buildTopologyModel({
    vlanRxRows: [row({ network: 'net-a', vlan: '10', sw_name: 'sw-a' }, 1_000_000)],
    vlanTxRows: [row({ network: 'net-a', vlan: '10', sw_name: 'sw-a' }, 500_000)],
    deviceRows,
    deviceRxRows: [row({ name: 'sw-a' }, 2_000_000)],
    deviceTxRows: [row({ name: 'sw-a' }, 1_000_000)],
    wanRxRows: [row({ port: 'wan-a' }, 3_000_000)],
    wanTxRows: [row({ port: 'wan-a' }, 1_000_000)],
  });
  assert.equal(model.edges.find((edge) => edge.type === 'client').bytesPerSecond, 1_500_000);
  assert.equal(model.edges.find((edge) => edge.type === 'device' && edge.from === 'device:sw-a').bytesPerSecond, 3_000_000);
  assert.equal(model.edges.find((edge) => edge.type === 'wan').bytesPerSecond, 4_000_000);
  assert.equal(model.nodes.find((node) => node.id === 'internet').bytesPerSecond, 4_000_000);
  assert.deepEqual(edgeMotion({ type: 'client', bytesPerSecond: null }), { rate: 0, density: 0, speed: 0 });
  assert.ok(edgeMotion({ type: 'client', bytesPerSecond: 8_000_000 }).density > edgeMotion({ type: 'client', bytesPerSecond: 100 }).density);
  assert.ok(edgeMotion({ type: 'client', bytesPerSecond: 8_000_000 }).speed > edgeMotion({ type: 'client', bytesPerSecond: 100 }).speed);
});

test('firewall event rows create top action-colored inter-network arcs only with measured series', () => {
  const inputs = {
    vlanRxRows: [row({ network: 'net-a', vlan: '10' }, 1), row({ network: 'net-b', vlan: '20' }, 1)],
    deviceRows,
  };
  const withoutEvents = buildTopologyModel(inputs);
  assert.equal(withoutEvents.edges.some((edge) => edge.type === 'firewall'), false);
  const withEvents = buildTopologyModel({ ...inputs, flowRows: [
    row({ in_net: 'net-a', out_net: 'net-b', action: 'accept' }, 0.8),
    row({ in_net: 'net-a', out_net: 'net-b', action: 'deny' }, 0.2),
  ] });
  const arcs = withEvents.edges.filter((edge) => edge.type === 'firewall');
  assert.equal(arcs.length, 2);
  assert.equal(arcs.find((edge) => edge.action === 'deny').color, '#ff3b5c');
  assert.equal(arcs.find((edge) => edge.action === 'accept').eventsPerSecond, 0.8);
  assert.equal(edgeMotion(arcs[0]).density > 0, true);
  const topPair = buildTopologyModel({ ...inputs, maxFlowPairs: 1, flowRows: [
    row({ in_net: 'net-a', out_net: 'net-b', action: 'accept' }, 0.2),
    row({ in_net: 'net-a', out_net: 'net-b', action: 'deny' }, 0.3),
    row({ in_net: 'net-b', out_net: 'net-a', action: 'accept' }, 0.4),
  ] }).edges.filter((edge) => edge.type === 'firewall');
  assert.equal(topPair.length, 2);
  assert.ok(topPair.every((edge) => edge.from.includes('net-a') && edge.to.includes('net-b')));
});

test('layout keeps all VLAN hubs inside the viewport and separated while same-device VLANs huddle', () => {
  const vlanRxRows = Array.from({ length: 8 }, (_, index) => row({ network: `net-${index}`, vlan: String(index + 1), sw_name: 'sw-a' }, index + 1));
  const model = buildTopologyModel({ vlanRxRows, vlanTxRows: vlanRxRows.map((entry) => ({ ...entry, value: entry.value / 2 })), deviceRows,
    groups: [{ name: 'unmatched', apps: [] }] });
  const hubs = model.nodes.filter((node) => node.type === 'vlan' || node.type === 'group');
  const vlans = hubs.filter((node) => node.type === 'vlan');
  const positions = model.positions;
  for (const point of Object.values(positions)) {
    assert.ok(point.x >= 0 && point.x <= 1920);
    assert.ok(point.y >= 0 && point.y <= 1080);
  }
  for (let left = 0; left < hubs.length; left++) for (let right = left + 1; right < hubs.length; right++) {
    const a = positions[hubs[left].id], b = positions[hubs[right].id];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 140, `${hubs[left].name} overlaps ${hubs[right].name}`);
  }
  const access = positions['device:sw-a'], clustered = vlans.map((hub) => positions[hub.id]);
  assert.ok(Math.max(...clustered.map((point) => Math.hypot(point.x - access.x, point.y - access.y))) < 500);
});

test('firewall panel rows retain country, flow, and rule rates in descending order', () => {
  const rows = buildFirewallRows(
    [row({ country_code: 'AA', country: 'Country A' }, 0.2), row({ country_code: 'BB', country: 'Country B' }, 0.5)],
    [row({ in_net: 'net-a', out_net: 'net-b', action: 'deny' }, 0.3), row({ in_net: 'net-b', out_net: 'net-a', action: 'accept' }, 0.4)],
    [row({ rule: 'rule-a', action: 'deny' }, 0.1)],
  );
  assert.deepEqual(rows.countries.map((entry) => [entry.name, entry.rate]), [['Country B', 0.5], ['Country A', 0.2]]);
  assert.deepEqual(rows.flows.map((entry) => entry.action), ['accept', 'deny']);
  assert.deepEqual(rows.rules.map((entry) => [entry.name, entry.action]), [['rule-a', 'deny']]);
  assert.deepEqual(buildFirewallRows([], [], []), { countries: [], flows: [], rules: [] });
});

test('MC1 query keys use summed five-minute rates and retain only meaningful labels', () => {
  assert.match(Q.vlanRxBytes, /sum by \(network, vlan, sw_name, ap_name\).*rate\(unpoller_client_receive_bytes_total\[5m\]\)/);
  assert.match(Q.deviceInfo, /group by \(name, model, type\) \(unpoller_device_info\)/);
  assert.match(Q.fwFlowEvents, /sum by \(in_vlan, out_vlan, action\).*rate\(unifi_fw_events_total\[5m\]\)/);
  assert.match(Q.fwWanDrops, /sum by \(country_code, country\).*rate\(unifi_wan_drops_total\[5m\]\)/);
  assert.match(Q.fwRuleEvents, /sum by \(rule, action\).*rate\(unifi_fw_events_total\[5m\]\)/);
});

test('firewall VLAN ids map to network names, and rejects count as denies', () => {
  const clients = [{ labels: { network: 'net-a', vlan: '10' }, value: 1 }, { labels: { network: 'net-u' }, value: 1 }];
  const rows = namedFlowRows([
    { labels: { in_vlan: '10', out_vlan: '0', action: 'accept' }, value: 2 },
    { labels: { in_vlan: 'wan', out_vlan: 'gateway', action: 'reject' }, value: 1 },
    { labels: { in_vlan: '99', out_vlan: 'wg0', action: 'deny' }, value: 3 },
  ], clients);
  assert.deepEqual(rows.map((row) => [row.labels.in_net, row.labels.out_net, row.labels.action]), [
    ['net-a', 'net-u', 'accept'], ['WAN', 'gateway', 'deny'], ['VLAN 99', 'wg0', 'deny'],
  ]);
});
