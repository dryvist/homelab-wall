const PALETTE = ['#3ee6ff', '#7b8cff', '#38ff9c', '#ffb347', '#ff4fd8', '#b6ff3e', '#ff3b5c', '#e8f4ff', '#8ab8ff', '#ffd23e'];
const aliases = new Map([
  ['mgmt', 'management'], ['svc', 'services'], ['svcs', 'services'], ['prod', 'production'],
  ['dev', 'development'], ['infra', 'infrastructure'],
]);

export function normalizeNetwork(name) {
  const key = String(name ?? '').toLowerCase().replace(/[\s_-]/g, '');
  return aliases.get(key) || key;
}

export function matchNetworkGroup(group, network) {
  return !!normalizeNetwork(group?.name) && normalizeNetwork(group?.name) === normalizeNetwork(network);
}

export function classifyDeviceRole(type) {
  if (type === 'udm' || type === 'ugw') return 'gateway';
  if (type === 'usw') return 'switch';
  if (type === 'uap') return 'ap';
  return 'unknown';
}

function addRate(map, key, value) {
  if (!Number.isFinite(value)) return;
  map.set(key, (map.get(key) ?? 0) + Math.max(0, value));
}

function ratesByName(rows) {
  const result = new Map();
  for (const row of rows || []) {
    const name = row.labels?.name;
    if (typeof name === 'string' && name) addRate(result, name, row.value);
  }
  return result;
}

function networkStats(rxRows, txRows) {
  const networks = new Map();
  const attribution = new Map();
  for (const [direction, rows] of [['rx', rxRows], ['tx', txRows]]) {
    for (const row of rows || []) {
      const labels = row.labels || {}, network = labels.network;
      if (typeof network !== 'string' || !network || !Number.isFinite(row.value)) continue;
      const vlan = String(labels.vlan ?? ''), key = `${network}\0${vlan}`;
      const stat = networks.get(key) || { key, network, vlan, rxBytes: null, txBytes: null, accessDeviceId: null };
      const field = direction === 'rx' ? 'rxBytes' : 'txBytes';
      stat[field] = (stat[field] ?? 0) + Math.max(0, row.value);
      networks.set(key, stat);
      const deviceName = String(labels.sw_name || labels.ap_name || '').trim();
      if (deviceName) {
        const devices = attribution.get(key) || new Map();
        const entry = devices.get(deviceName) || { name: deviceName, role: labels.sw_name ? 'switch' : 'ap', bytes: 0 };
        entry.bytes += Math.max(0, row.value);
        devices.set(deviceName, entry);
        attribution.set(key, devices);
      }
    }
  }
  for (const [key, stat] of networks) {
    const devices = [...(attribution.get(key)?.values() || [])].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    stat.accessDeviceId = devices.length ? `device:${devices[0].name}` : null;
    stat.attributedDevice = devices[0] || null;
  }
  return [...networks.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function totalRate(...values) {
  const present = values.filter(Number.isFinite);
  return present.length ? present.reduce((sum, value) => sum + Math.max(0, value), 0) : null;
}

export function dominantAccessDevice(rxRows, txRows, network, vlan) {
  const key = `${network}\0${String(vlan ?? '')}`;
  return networkStats(rxRows, txRows).find((stat) => stat.key === key)?.attributedDevice?.name ?? null;
}

function appendHub(nodes, stat, matchingGroups, index) {
  const apps = [...new Set(matchingGroups.flatMap((group) => group.apps || []))];
  const firstGroup = matchingGroups[0];
  nodes.push({
    id: `vlan:${encodeURIComponent(stat.network)}:${encodeURIComponent(stat.vlan)}`, type: 'vlan', key: stat.key, network: stat.network, vlan: stat.vlan,
    name: stat.vlan ? `${stat.network} · VLAN ${stat.vlan}` : stat.network,
    rxBytes: stat.rxBytes, txBytes: stat.txBytes, bytesPerSecond: totalRate(stat.rxBytes, stat.txBytes),
    accessDeviceId: stat.accessDeviceId, apps, hasGroup: matchingGroups.length > 0,
    color: firstGroup?.c || PALETTE[index % PALETTE.length],
  });
}

export function buildTopologyModel({
  groups = [], vlanRxRows = [], vlanTxRows = [], deviceRows = [], deviceRxRows = [], deviceTxRows = [],
  wanRxRows = [], wanTxRows = [], flowRows = [], maxFlowPairs = 12,
} = {}) {
  const nodes = [], edges = [];
  const rxByDevice = ratesByName(deviceRxRows), txByDevice = ratesByName(deviceTxRows);
  const deviceInfo = new Map();
  for (const row of deviceRows || []) {
    const name = row.labels?.name, role = classifyDeviceRole(row.labels?.type);
    if (typeof name === 'string' && name && role !== 'unknown') deviceInfo.set(name, { name, role, model: row.labels.model || '' });
  }
  const gatewayInfo = [...deviceInfo.values()].filter((device) => device.role === 'gateway').sort((a, b) => a.name.localeCompare(b.name))[0];
  const stats = networkStats(vlanRxRows, vlanTxRows);
  const hasWan = totalRate(...(wanRxRows || []).map((row) => row.value), ...(wanTxRows || []).map((row) => row.value)) != null;
  const needsGateway = !!gatewayInfo || stats.length > 0 || hasWan || deviceInfo.size > 0;
  const gatewayId = needsGateway ? 'gateway' : null;
  if (gatewayId) {
    const name = gatewayInfo?.name || 'Gateway';
    nodes.push({ id: gatewayId, type: 'gateway', role: 'gateway', name, rxBytes: rxByDevice.get(name) ?? null, txBytes: txByDevice.get(name) ?? null,
      bytesPerSecond: totalRate(rxByDevice.get(name), txByDevice.get(name)), color: '#3ee6ff' });
  }

  const deviceNames = new Set([...deviceInfo.values()].filter((device) => ['switch', 'ap'].includes(device.role)).map((device) => device.name));
  for (const stat of stats) if (stat.attributedDevice) deviceNames.add(stat.attributedDevice.name);
  for (const name of [...deviceNames].sort((a, b) => a.localeCompare(b))) {
    const known = deviceInfo.get(name), attributed = stats.find((stat) => stat.attributedDevice?.name === name)?.attributedDevice;
    const role = known?.role || attributed?.role;
    if (!['switch', 'ap'].includes(role)) continue;
    nodes.push({ id: `device:${name}`, type: 'device', role, name, model: known?.model || '',
      rxBytes: rxByDevice.get(name) ?? null, txBytes: txByDevice.get(name) ?? null,
      bytesPerSecond: totalRate(rxByDevice.get(name), txByDevice.get(name)), color: role === 'ap' ? '#7b8cff' : '#38ff9c' });
  }

  stats.forEach((stat, index) => {
    const matchingGroups = groups.filter((group) => matchNetworkGroup(group, stat.network));
    appendHub(nodes, stat, matchingGroups, index);
  });
  const matchedGroups = new Set(stats.flatMap((stat) => groups.filter((group) => matchNetworkGroup(group, stat.network))));
  for (const [index, group] of groups.entries()) {
    if (matchedGroups.has(group)) continue;
    nodes.push({ id: `group:${group.name}`, type: 'group', name: group.name, apps: group.apps || [], hasGroup: true,
      color: group.c || PALETTE[index % PALETTE.length], rxBytes: null, txBytes: null, bytesPerSecond: null });
  }

  if (gatewayId) {
    for (const node of nodes.filter((candidate) => candidate.type === 'device')) {
      edges.push({ id: `device:${node.id}`, type: 'device', from: node.id, to: gatewayId,
        rxBytes: node.rxBytes, txBytes: node.txBytes, bytesPerSecond: node.bytesPerSecond, color: node.color });
    }
    for (const node of nodes.filter((candidate) => candidate.type === 'vlan')) {
      const target = nodes.some((candidate) => candidate.id === node.accessDeviceId) ? node.accessDeviceId : gatewayId;
      edges.push({ id: `client:${node.id}`, type: 'client', from: node.id, to: target,
        rxBytes: node.rxBytes, txBytes: node.txBytes, bytesPerSecond: node.bytesPerSecond, color: node.color });
    }
  }

  const wanRx = totalRate(...(wanRxRows || []).map((row) => row.value));
  const wanTx = totalRate(...(wanTxRows || []).map((row) => row.value));
  if (gatewayId && hasWan) {
    nodes.push({ id: 'internet', type: 'internet', name: 'Internet', rxBytes: wanRx, txBytes: wanTx,
      bytesPerSecond: totalRate(wanRx, wanTx), color: '#3ee6ff' });
    edges.push({ id: 'wan', type: 'wan', from: gatewayId, to: 'internet', rxBytes: wanRx, txBytes: wanTx,
      bytesPerSecond: totalRate(wanRx, wanTx), color: '#3ee6ff' });
  }

  const byNetwork = new Map();
  for (const node of nodes.filter((candidate) => candidate.type === 'vlan')) {
    const key = normalizeNetwork(node.network), list = byNetwork.get(key) || [];
    list.push(node); byNetwork.set(key, list);
  }
  const flows = new Map();
  for (const row of flowRows || []) {
    const labels = row.labels || {}, action = String(labels.action || '').toLowerCase();
    if (!['accept', 'deny'].includes(action) || !Number.isFinite(row.value)) continue;
    const source = byNetwork.get(normalizeNetwork(labels.in_net)) || [], target = byNetwork.get(normalizeNetwork(labels.out_net)) || [];
    if (source.length !== 1 || target.length !== 1 || source[0].id === target[0].id) continue;
    const key = `${source[0].id}\0${target[0].id}\0${action}`;
    const edge = flows.get(key) || { id: `firewall:${key}`, type: 'firewall', from: source[0].id, to: target[0].id, action, eventsPerSecond: 0,
      color: action === 'deny' ? '#ff3b5c' : source[0].color };
    edge.eventsPerSecond += Math.max(0, row.value); flows.set(key, edge);
  }
  const pairRates = new Map();
  for (const edge of flows.values()) {
    const pair = `${edge.from}\0${edge.to}`;
    pairRates.set(pair, (pairRates.get(pair) || 0) + edge.eventsPerSecond);
  }
  const topPairs = new Set([...pairRates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxFlowPairs).map(([pair]) => pair));
  edges.push(...[...flows.values()].filter((edge) => topPairs.has(`${edge.from}\0${edge.to}`))
    .sort((a, b) => b.eventsPerSecond - a.eventsPerSecond || a.id.localeCompare(b.id)));
  return { nodes, edges, positions: layoutTopology(nodes) };
}

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

export function layoutTopology(nodes, width = 1920, height = 1080) {
  const positions = {}, cx = width / 2, cy = height / 2, minDimension = Math.min(width, height);
  const marginX = Math.min(140, width * 0.18), marginY = Math.min(105, height * 0.18);
  const devices = nodes.filter((node) => node.type === 'device').sort((a, b) => a.name.localeCompare(b.name));
  const gateways = nodes.filter((node) => node.type === 'gateway');
  const gateway = gateways[0];
  if (gateway) positions[gateway.id] = { x: cx, y: cy };
  const deviceGap = devices.length > 1 ? 112 / (2 * Math.sin(Math.PI / (devices.length + 1))) : 0;
  const deviceRadius = Math.min(minDimension * 0.23, Math.max(120, minDimension * 0.12, deviceGap));
  const reserveAngle = -Math.PI / 4;
  devices.forEach((node, index) => {
    const angle = reserveAngle + ((index + 1) / (devices.length + 1)) * Math.PI * 2;
    positions[node.id] = { x: cx + Math.cos(angle) * deviceRadius, y: cy + Math.sin(angle) * deviceRadius };
  });
  if (nodes.some((node) => node.type === 'internet')) {
    positions.internet = { x: cx + Math.cos(reserveAngle) * deviceRadius * 0.5, y: cy + Math.sin(reserveAngle) * deviceRadius * 0.5 };
  }

  const hubs = nodes.filter((node) => node.type === 'vlan' || node.type === 'group');
  const clusters = new Map();
  for (const node of hubs) {
    const parentId = node.type === 'vlan' && positions[node.accessDeviceId] ? node.accessDeviceId : gateway?.id || null;
    const list = clusters.get(parentId) || []; list.push(node); clusters.set(parentId, list);
  }
  for (const [parentId, cluster] of clusters) {
    const parent = positions[parentId] || { x: cx, y: cy };
    const angle = Math.atan2(parent.y - cy, parent.x - cx);
    const radius = parentId === gateway?.id ? minDimension * 0.19 : deviceRadius + minDimension * 0.12;
    const center = { x: cx + Math.cos(angle || -Math.PI / 2) * radius, y: cy + Math.sin(angle || -Math.PI / 2) * radius };
    const localRadius = cluster.length < 2 ? 0 : Math.max(58, cluster.length * 20);
    cluster.sort((a, b) => a.name.localeCompare(b.name)).forEach((node, index) => {
      const theta = -Math.PI / 2 + (index / cluster.length) * Math.PI * 2;
      positions[node.id] = { x: center.x + Math.cos(theta) * localRadius, y: center.y + Math.sin(theta) * localRadius };
    });
  }

  const placeable = hubs;
  const anchors = nodes.filter((node) => !['vlan', 'group'].includes(node.type));
  const maxHubGap = Math.min(144, Math.max(112, minDimension * 0.14));
  for (let pass = 0; pass < 220; pass++) {
    let moved = false;
    for (let i = 0; i < placeable.length; i++) for (let j = i + 1; j < placeable.length; j++) {
      const a = positions[placeable[i].id], b = positions[placeable[j].id];
      let dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
      if (distance >= maxHubGap) continue;
      if (!distance) { dx = (i + 1) * 0.31; dy = (j + 1) * 0.47; distance = Math.hypot(dx, dy); }
      const push = (maxHubGap - distance) * 0.52 / distance;
      a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push; moved = true;
      for (const point of [a, b]) { point.x = clamp(point.x, marginX, width - marginX); point.y = clamp(point.y, marginY, height - marginY); }
    }
    for (const hub of placeable) for (const anchor of anchors) {
      const point = positions[hub.id], fixed = positions[anchor.id];
      if (!fixed) continue;
      let dx = point.x - fixed.x, dy = point.y - fixed.y, distance = Math.hypot(dx, dy);
      if (distance >= 112) continue;
      if (!distance) { dx = 0.37; dy = 0.61; distance = Math.hypot(dx, dy); }
      const push = (112 - distance) / distance;
      point.x = clamp(point.x + dx * push, marginX, width - marginX);
      point.y = clamp(point.y + dy * push, marginY, height - marginY); moved = true;
    }
    if (!moved) break;
  }
  for (const point of Object.values(positions)) {
    point.x = clamp(point.x, marginX, width - marginX); point.y = clamp(point.y, marginY, height - marginY);
  }
  return positions;
}

export function edgeMotion(edge) {
  const rate = edge.type === 'firewall' ? edge.eventsPerSecond : edge.bytesPerSecond;
  if (!Number.isFinite(rate) || rate <= 0) return { rate: 0, density: 0, speed: 0 };
  const scale = edge.type === 'firewall' ? rate : rate * 8 / 1e6;
  return { rate, density: Math.min(22, Math.max(2, 2 + Math.ceil(Math.log10(1 + scale) * 5))),
    speed: Math.min(0.8, 0.12 + Math.log10(1 + scale) * 0.08) };
}

// Firewall events carry VLAN ids (`0` is the untagged network, `wan` a WAN port, `gateway` the gateway itself);
// client rows carry each network's name and VLAN id. Rejects count as denies.
export function namedFlowRows(flowRows = [], clientRows = []) {
  const names = new Map([['wan', 'WAN'], ['gateway', 'gateway']]);
  for (const row of clientRows || []) {
    const network = row.labels?.network;
    if (typeof network === 'string' && network) names.set(String(row.labels.vlan ?? '0'), network);
  }
  const name = (id) => names.get(String(id ?? '')) || (/^\d+$/.test(String(id ?? '')) ? `VLAN ${id}` : String(id || ''));
  return (flowRows || []).map((row) => {
    const labels = row.labels || {}, action = String(labels.action || '').toLowerCase();
    return { ...row, labels: { ...labels, in_net: name(labels.in_vlan), out_net: name(labels.out_vlan),
      action: action === 'reject' ? 'deny' : action } };
  });
}

export function buildFirewallRows(dropRows = [], flowRows = [], ruleRows = []) {
  const sorted = (rows, label, action = false) => rows.map((row) => ({
    name: label(row.labels || {}), action: action ? String(row.labels?.action || '').toLowerCase() : '', rate: row.value,
  })).filter((row) => row.name && Number.isFinite(row.rate) && row.rate >= 0)
    .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name) || a.action.localeCompare(b.action));
  const countries = sorted(dropRows, (labels) => labels.country || labels.country_code || '', false);
  const flows = sorted(flowRows, (labels) => labels.in_net && labels.out_net ? `${labels.in_net} → ${labels.out_net}` : '', true)
    .filter((row) => ['accept', 'deny'].includes(row.action));
  const rules = sorted(ruleRows, (labels) => labels.rule || '', true);
  return { countries, flows, rules };
}
