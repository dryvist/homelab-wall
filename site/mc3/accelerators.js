import { clamp } from '/lib/stage.js';
export const ANCHOR_DEFS = [
  { id: 'gpu-primary', kind: 'gpu', angle: 200 },
  { id: 'gpu-secondary', kind: 'gpu', angle: 250 },
  { id: 'mac-primary', kind: 'mac', angle: 290 },
  { id: 'mac-secondary', kind: 'mac', angle: 340 },
  { id: 'cloud', kind: 'cloud', angle: 90 },
];
const CLOUD = ANCHOR_DEFS.length - 1;
const ROLE = new Map(ANCHOR_DEFS.slice(0, CLOUD).map((d, i) => [d.id, i]));
const VENDOR_WORD = /^[A-Z]{4,}\s+/;
export const hostOf = (s) => {
  const rest = String(s ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const v6 = rest.match(/^\[([^\]]*)\]/);
  return (v6 ? v6[1] : rest.split(/[/:]/)[0]).toLowerCase();
};
export const isDim = (d) => (d.kind === 'cloud' ? d.active === 0 && d.models === 0 : d.busy == null || (d.models === 0 && d.active === 0));


export let accel = ANCHOR_DEFS.map((d) => ({ ...d, name: d.id, busy: null, active: 0, models: 0 }));
export function deriveAccelerators(r, overrides) {
  const hostRole = new Map();
  const names = ANCHOR_DEFS.slice(0, CLOUD).map(() => new Set());
  for (const row of r.gpuModel || []) {
    const role = row.labels.accelerator || 'gpu-primary';
    if (!ROLE.has(role)) continue;
    const host = hostOf(row.labels.instance);
    if (host) hostRole.set(host, role);
    if (row.labels.modelName) names[ROLE.get(role)].add(String(row.labels.modelName).replace(VENDOR_WORD, ''));
  }
  for (const row of r.macChip || []) {
    const role = row.labels.accelerator;
    if (!ROLE.has(role)) continue;
    const host = hostOf(row.labels.instance);
    if (host) hostRole.set(host, role);
    if (row.labels.chip) names[ROLE.get(role)].add(String(row.labels.chip));
  }

  const busy = ANCHOR_DEFS.map(() => null);
  for (const row of r.gpu || []) {
    if (ROLE.has(row.labels.accelerator) && Number.isFinite(row.value)) busy[ROLE.get(row.labels.accelerator)] = clamp(row.value, 0, 100);
  }

  const active = ANCHOR_DEFS.map(() => 0);
  let onDevices = 0;
  for (const row of [...(r.vllm || []), ...(r.llama || [])]) {
    const role = Number.isFinite(row.value) ? hostRole.get(hostOf(row.labels.instance)) : undefined;
    if (role == null) continue;
    active[ROLE.get(role)] += row.value;
    onDevices += row.value;
  }
  const inflight = r.inflight?.[0]?.value;
  const known = r.vllm != null && r.llama != null && Number.isFinite(inflight);
  active[CLOUD] = known ? Math.max(0, Math.round(inflight - onDevices)) : 0;

  const plain = ANCHOR_DEFS.map((d, i) => {
    const o = overrides[d.id];
    if (typeof o === 'string' && o.trim()) return o.trim();
    return i < CLOUD ? ([...names[i]].sort().join(' + ') || d.id) : d.id;
  });
  const copies = new Map();
  for (const n of plain) copies.set(n, (copies.get(n) ?? 0) + 1);
  accel = ANCHOR_DEFS.map((d, i) => ({
    ...d,
    name: d.kind !== 'cloud' && copies.get(plain[i]) > 1 ? `${plain[i]} · ${d.id.split('-')[1].toUpperCase()}` : plain[i],
    busy: busy[i], active: active[i], models: 0,
  }));
  return hostRole;
}

