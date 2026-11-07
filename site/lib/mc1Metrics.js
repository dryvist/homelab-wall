export function gpuByNode(modelRows, guestRows, busyRows) {
  const nodeByGuest = new Map((guestRows || []).map((row) => [row.labels.name, row.labels.node]));
  const busyByAccelerator = new Map();
  for (const row of busyRows || []) {
    const accelerator = row.labels.accelerator;
    if (accelerator == null || !Number.isFinite(row.value)) continue;
    busyByAccelerator.set(accelerator, Math.max(busyByAccelerator.get(accelerator) ?? -Infinity, row.value));
  }

  const result = new Map();
  for (const row of modelRows || []) {
    const accelerator = row.labels.accelerator;
    const guest = String(row.labels.instance ?? '').split('.')[0];
    const node = nodeByGuest.get(guest);
    if (accelerator == null || node == null) continue;
    const entry = result.get(node) || { hasAccelerator: true, value: null };
    const value = busyByAccelerator.get(accelerator);
    if (Number.isFinite(value)) entry.value = Math.max(entry.value ?? -Infinity, value);
    result.set(node, entry);
  }
  return result;
}

const shortHost = (value = '') => String(value).split(':')[0].split('.')[0];

export function buildStorageRows(sizeRows, availRows, pveRows, pveFailed = false) {
  const availableByDevice = new Map((availRows || []).map((row) => [`${row.labels.instance}|${row.labels.device}`, row.value]));
  const pveByStorage = new Map();
  for (const row of pveRows || []) {
    const match = /^storage\/([^/]+)\/([^/]+)$/.exec(row.labels.id || '');
    if (!match || !Number.isFinite(row.value)) continue;
    const key = `${shortHost(match[1])}|${match[2]}`;
    pveByStorage.set(key, Math.max(pveByStorage.get(key) ?? -Infinity, row.value));
  }

  const pools = new Map(), best = new Map(), hosts = new Map();
  let incomplete = false;
  for (const row of sizeRows || []) {
    const labels = row.labels, size = row.value;
    if (!Number.isFinite(size) || size <= 0) continue;
    const available = availableByDevice.get(`${labels.instance}|${labels.device}`);
    const host = shortHost(labels.instance);
    if (labels.fstype === 'zfs') {
      const name = String(labels.device || '').split('/')[0];
      if (!name) continue;
      const key = `${host}|${name}`;
      const pool = pools.get(key) || { host, name, refSum: 0, refCount: 0, free: null, datasets: 0 };
      pool.datasets += 1;
      if (Number.isFinite(available)) {
        pool.refSum += size - available;
        pool.refCount += 1;
        pool.free = Math.max(pool.free ?? -Infinity, available);
      } else {
        incomplete = true;
      }
      pools.set(key, pool);
      continue;
    }
    if (size <= 1e9) continue;
    if (!Number.isFinite(available)) incomplete = true;
    const name = labels.mountpoint.split('/').filter(Boolean).pop() || labels.mountpoint;
    const key = `${labels.device}|${labels.mountpoint}`;
    const used = Number.isFinite(available) ? size - available : null;
    const current = best.get(key);
    if (!current || size > current.size || (size === current.size && current.used == null && used != null)) best.set(key, { host, name, size, used });
    if (!hosts.has(key)) hosts.set(key, new Set());
    hosts.get(key).add(host);
  }

  for (const pool of pools.values()) {
    const refSum = pool.refCount ? pool.refSum : null;
    let pveUsed = null;
    if (!pveFailed) {
      if (pool.name === 'rpool') {
        const local = pveByStorage.get(`${pool.host}|local`);
        const localZfs = pveByStorage.get(`${pool.host}|local-zfs`);
        if (Number.isFinite(local) && Number.isFinite(localZfs)) pveUsed = local + localZfs;
        else incomplete = true;
      } else {
        pveUsed = pveByStorage.get(`${pool.host}|${pool.name}`) ?? null;
      }
    }
    if (pveFailed) incomplete = true;
    const used = refSum == null ? pveUsed : pveUsed == null ? refSum : Math.max(refSum, pveUsed);
    const size = used == null || pool.free == null ? null : used + pool.free;
    best.set(`zfs:${pool.host}:${pool.name}`, { host: pool.host, name: pool.name, size, used, free: pool.free, refSum });
  }

  const rows = [...best].map(([key, row]) => ({
    ...row,
    host: key.startsWith('zfs:') ? row.host : hosts.get(key).size > 1 ? 'shared' : row.host,
  })).sort((a, b) => (b.size ?? -Infinity) - (a.size ?? -Infinity));
  return { rows, incomplete };
}

export function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 900e9 && bytes <= 1e12) return '1T';
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)}T` : `${Math.round(bytes / 1e9)}G`;
}

const normalizeNetwork = (name) => String(name ?? '').toLowerCase().replace(/[_-]/g, '');

export function formatMbps(bytesPerSecond) {
  return Number.isFinite(bytesPerSecond) ? (bytesPerSecond * 8 / 1e6).toFixed(1) : '—';
}

export function buildTopologyHubs(groups, rxRows, txRows) {
  const networks = new Map();
  for (const [direction, rows] of [['rx', rxRows], ['tx', txRows]]) {
    for (const row of rows || []) {
      const name = row.labels.network;
      if (typeof name !== 'string' || !name || !Number.isFinite(row.value)) continue;
      const network = networks.get(name) || { name, rxBytes: null, txBytes: null };
      const key = direction === 'rx' ? 'rxBytes' : 'txBytes';
      network[key] = (network[key] ?? 0) + row.value;
      networks.set(name, network);
    }
  }

  const groupByName = new Map();
  for (const group of groups || []) {
    const key = normalizeNetwork(group.name);
    if (key && !groupByName.has(key)) groupByName.set(key, group);
  }
  const matched = new Set();
  const hubs = [...networks.values()].sort((a, b) => a.name.localeCompare(b.name)).map((network) => {
    const group = groupByName.get(normalizeNetwork(network.name));
    if (group) matched.add(group);
    return {
      key: `network:${network.name}`, name: network.name, isNetwork: true, hasGroup: !!group,
      apps: group?.apps || [], color: group?.c || null, rxBytes: network.rxBytes, txBytes: network.txBytes,
    };
  });
  for (const group of groups || []) {
    if (!matched.has(group)) hubs.push({ key: `group:${group.name}`, name: group.name, isNetwork: false, hasGroup: true, apps: group.apps, color: group.c, rxBytes: null, txBytes: null });
  }
  return hubs;
}
