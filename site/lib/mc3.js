// Colours follow name order, so a model keeps its colour when its request rank changes.
export function assignModelColors(models, palette) {
  const names = models.map((model) => model.n).sort();
  return models.map((model) => ({ ...model, color: palette[names.indexOf(model.n)] }));
}

export function billingClassValues(rows) {
  if (!Array.isArray(rows)) return { local: null, cloud: null };
  const totals = { local: 0, cloud: 0 };
  const measured = { local: false, cloud: false };
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const kind = row.labels?.tag_telemetry_billing_class_local === 'true' ? 'local' : 'cloud';
    totals[kind] += row.value;
    measured[kind] = true;
  }
  return { local: measured.local ? totals.local : null, cloud: measured.cloud ? totals.cloud : null };
}

export function modelCounts(models, localModelRows) {
  if (!Array.isArray(models) || !Array.isArray(localModelRows)) return null;
  const split = splitByClass(models, localModelRows.map((row) => row.labels?.model));
  const count = (list) => ({ up: list.filter((model) => model.up).length, total: list.length });
  return { local: count(split.local), cloud: count(split.cloud) };
}

export function classPair(local, cloud, format = (value) => String(value)) {
  const display = (value) => Number.isFinite(value) ? format(value) : '—';
  return `local ${display(local)} · cloud ${display(cloud)}`;
}

export function modelCountPair(counts, upOnly = false) {
  const side = (kind) => counts == null ? '—'
    : upOnly ? `${counts[kind].up}/${counts[kind].total}` : String(counts[kind].total);
  return `local ${side('local')} · cloud ${side('cloud')}${upOnly ? ' UP' : ' MODELS'}`;
}

export function splitByClass(models, localNames) {
  const local = new Set(localNames || []);
  return {
    local: models.filter((model) => local.has(model.n)),
    cloud: models.filter((model) => !local.has(model.n)),
  };
}

const VENDOR_WORD = /^[A-Z]{4,}\s+/;

export function shortDevice(raw) {
  const name = String(raw ?? '').trim().replace(VENDOR_WORD, '').trim();
  if (!name) return '';

  const words = name.split(/\s+/);
  // The identifier starts at an all-capitals word or a letter-and-digit word, never at a bare number.
  const start = Math.max(0, words.findIndex((word) => /^[A-Z][A-Z0-9]*$/.test(word) || (/[A-Za-z]/.test(word) && /\d/.test(word))));
  const digit = words.findIndex((word, index) => index >= start && /\d/.test(word));
  if (digit < 0) return name;

  const result = words.slice(start, digit + 1);
  if (/^[A-Za-z]{2,5}$/.test(words[digit + 1] ?? '')) result.push(words[digit + 1]);
  return result.join(' ');
}
