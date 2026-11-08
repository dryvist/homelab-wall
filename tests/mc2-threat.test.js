import assert from 'node:assert/strict';
import test from 'node:test';
import { COUNTRY_CENTER_COUNT, countryCenter, placeCountries } from '../site/lib/mc2CountryCenters.js';
import { chooseFeedState, formatEventsPerMinute, splitCountryWindows, topCountries, wanTotals } from '../site/lib/mc2Threat.js';

test('MC2 splits rate and hour series into countries and ranks the requested field', () => {
  const countries = splitCountryWindows([
    { labels: { country_code: 'US', country: 'United States', window: 'rate' }, value: 0.35 },
    { labels: { country_code: 'US', country: 'United States', window: 'hour' }, value: 550 },
    { labels: { country_code: 'BG', country: 'Bulgaria', window: 'rate' }, value: 0.12 },
    { labels: { country_code: 'BG', country: 'Bulgaria', window: 'hour' }, value: 208 },
    { labels: { country_code: 'DE', country: 'Germany', window: 'hour' }, value: 180 },
  ]);

  assert.deepEqual(topCountries(countries, 'rate', 1).map(({ code }) => code), ['US']);
  assert.deepEqual(topCountries(countries, 'hour', 2).map(({ code }) => code), ['US', 'BG']);
  assert.equal(countries.find(({ code }) => code === 'US').hour, 550);
});

test('MC2 places known country codes and counts unknown codes', () => {
  assert.ok(COUNTRY_CENTER_COUNT >= 250);
  assert.deepEqual(countryCenter('us'), [39, -98]);
  assert.deepEqual(placeCountries([{ code: 'US' }, { code: 'BG' }, { code: 'ZZ' }]), {
    placed: [{ code: 'US', center: [39, -98] }, { code: 'BG', center: [42.7, 25.5] }],
    unplaced: 1,
  });
});

test('MC2 formats per-second rates as events per minute', () => {
  assert.equal(formatEventsPerMinute(0.35), '21');
  assert.equal(formatEventsPerMinute(0.123), '7.4');
  assert.equal(formatEventsPerMinute(null), '—');
});

test('MC2 chooses no-feed, error, stale and ok states from query evidence', () => {
  assert.deepEqual(chooseFeedState(), { state: 'no-feed', message: '' });
  assert.deepEqual(chooseFeedState({ error: 'query 500' }), { state: 'error', message: 'query 500' });
  assert.deepEqual(chooseFeedState({ error: 'query 500', hasLastGood: true }), { state: 'stale', message: 'STALE' });
  assert.deepEqual(chooseFeedState({ hasSeries: true }), { state: 'ok', message: '' });
});

test('WAN totals read the rate and hour windows and leave missing windows empty', () => {
  assert.deepEqual(wanTotals([{ labels: { window: 'rate' }, value: 0.5 }, { labels: { window: 'hour' }, value: 1200 }]), { rate: 0.5, hour: 1200 });
  assert.deepEqual(wanTotals([{ labels: { window: 'hour' }, value: 3 }]), { rate: null, hour: 3 });
  assert.deepEqual(wanTotals([]), { rate: null, hour: null });
});
