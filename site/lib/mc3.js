export function assignModelColors(models, palette) {
  return models.map((model, index) => ({ ...model, color: palette[index] }));
}

const VENDOR_WORD = /^[A-Z]{4,}\s+/;

export function shortDevice(raw) {
  const name = String(raw ?? '').trim().replace(VENDOR_WORD, '').trim();
  if (!name) return '';

  const words = name.split(/\s+/);
  const start = words.findIndex((word) => /^[A-Z0-9]+$/.test(word) || /\d/.test(word));
  const digit = words.findIndex((word, index) => index >= start && /\d/.test(word));
  if (digit < 0) return name;

  const result = words.slice(start, digit + 1);
  if (/^[A-Za-z]{2,5}$/.test(words[digit + 1] ?? '')) result.push(words[digit + 1]);
  return result.join(' ');
}
