export function splitCountryWindows(rows) {
  const countries = new Map();
  for (const row of rows ?? []) {
    const { country_code: code, country, window } = row.labels ?? {};
    if (!code || !country || !['rate', 'hour'].includes(window) || !Number.isFinite(row.value)) continue;
    const key = `${code}\u0000${country}`;
    const item = countries.get(key) ?? { code, country, rate: null, hour: null };
    item[window] = row.value;
    countries.set(key, item);
  }
  return [...countries.values()];
}

export function topCountries(countries, field, limit) {
  return countries
    .filter((country) => Number.isFinite(country[field]))
    .sort((a, b) => b[field] - a[field] || a.code.localeCompare(b.code))
    .slice(0, limit);
}

export function formatEventsPerMinute(ratePerSecond) {
  if (!Number.isFinite(ratePerSecond)) return '—';
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(ratePerSecond * 60);
}

export function chooseFeedState({ error = '', hasSeries = false, hasLastGood = false } = {}) {
  if (error) return { state: hasLastGood ? 'stale' : 'error', message: hasLastGood ? 'STALE' : error };
  if (!hasSeries) return { state: 'no-feed', message: '' };
  return { state: 'ok', message: '' };
}

export function wanTotals(rows) {
  const value = (window) => (rows || []).find((row) => row.labels?.window === window && Number.isFinite(row.value))?.value ?? null;
  return { rate: value('rate'), hour: value('hour') };
}
