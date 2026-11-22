// Readers for the Mac memory series (Q.macRamUsed .. Q.macPressure, Q.macModelMemory). Each takes the rows
// Prometheus returned for one query and keys them by short host name. A host with no series has no entry,
// so a caller holds its last good reading or shows it pending; nothing here invents a value.
import { shortHost } from './prom.js';

// Instant rows -> Map(host -> value), finite values only.
export function hostValues(rows) {
  const out = new Map();
  for (const row of rows || []) {
    if (Number.isFinite(row.value)) out.set(shortHost(row.labels.instance), row.value);
  }
  return out;
}

// One entry per host that reported any Mac series: RAM and swap in bytes, pressure in percent, and
// mem as RAM used in percent of RAM total (null when either side is missing).
export function macReadings({ ramUsed, ramTotal, swapUsed, swapTotal, pressure }) {
  const used = hostValues(ramUsed);
  const total = hostValues(ramTotal);
  const swap = hostValues(swapUsed);
  const swapAll = hostValues(swapTotal);
  const press = hostValues(pressure);
  const hosts = new Set([...used.keys(), ...total.keys(), ...swap.keys(), ...swapAll.keys(), ...press.keys()]);
  const out = new Map();
  for (const host of hosts) {
    const ram = used.get(host) ?? null;
    const ramAll = total.get(host) ?? null;
    out.set(host, {
      ram,
      ramTotal: ramAll,
      mem: ram != null && ramAll > 0 ? (100 * ram) / ramAll : null,
      swap: swap.get(host) ?? null,
      swapTotal: swapAll.get(host) ?? null,
      pressure: press.get(host) ?? null,
    });
  }
  return out;
}

// Per-model resident memory: one row per (host, model), grouped by host and largest first. share is the
// model's bytes as a percent of its host's RAM total, or null when that total is unknown.
export function modelMemoryRows(rows, ramTotalByHost) {
  return (rows || [])
    .filter((row) => row.labels.model && Number.isFinite(row.value))
    .map((row) => {
      const host = shortHost(row.labels.instance);
      const total = ramTotalByHost?.get(host) ?? null;
      return {
        host,
        model: row.labels.model,
        bytes: row.value,
        share: total > 0 ? Math.min(100, (100 * row.value) / total) : null,
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host) || b.bytes - a.bytes || a.model.localeCompare(b.model));
}
