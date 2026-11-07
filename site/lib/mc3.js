// Colours follow name order, so a model keeps its colour when its request rank changes.
export function assignModelColors(models, palette) {
  const names = models.map((model) => model.n).sort();
  return models.map((model) => ({ ...model, color: palette[names.indexOf(model.n)] }));
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
