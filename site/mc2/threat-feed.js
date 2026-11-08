import { query } from '/lib/prom.js';
import { Q } from '/lib/queries.js';
import { esc, onDispose, setState } from '/lib/stage.js';
import { placeCountries } from '../lib/mc2CountryCenters.js';
import { chooseFeedState, formatEventsPerMinute, splitCountryWindows, topCountries, wanTotals } from '../lib/mc2Threat.js';

const $ = (id) => document.getElementById(id);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'query failed');
}

export function createThreatFeed(onTraffic) {
  const model = {
    countries: [], rules: [], countryError: '', ruleError: '', countryLastGood: false, ruleLastGood: false,
    countryStaleData: false, ruleStaleData: false, wan: { rate: null, hour: null }, wanError: '', wanStaleData: false, wanLastGood: false,
  };

  function renderBlocked(state, countries) {
    const panel = $('blocked');
    setState(panel, state.state, state.message);
    const container = $('blocked-rows');
    const rowMarkup = (country) => `<div class="country-row">
      <span class="country-code">${esc(country.code)}</span>
      <span class="country-name">${esc(country.country)}</span>
      <b class="num country-events">${esc(formatEventsPerMinute(country.rate))}</b>
      <b class="num country-hour">${esc(Number.isFinite(country.hour) ? Math.round(country.hour).toLocaleString('en') : '—')}</b>
    </div>`;
    container.innerHTML = countries.map(rowMarkup).join('');
    const firstRow = container.firstElementChild;
    if (!firstRow) return;
    const heading = panel.querySelector('h2');
    const listHeading = panel.querySelector('.blocked-list-head');
    const rowHeight = firstRow.offsetHeight;
    const available = Math.max(0, panel.offsetHeight - heading.offsetHeight - listHeading.offsetHeight);
    if (!rowHeight || !available) return;
    const capacity = Math.floor(available / rowHeight);
    const visibleCount = countries.length > capacity ? Math.max(0, capacity - 1) : countries.length;
    const more = countries.length - visibleCount;
    container.innerHTML = countries.slice(0, visibleCount).map(rowMarkup).join('');
    if (more > 0) container.innerHTML += `<div class="country-row country-more">+${more} more</div>`;
  }

  function render() {
    const countryHasSeries = model.countries.some((country) => Number.isFinite(country.rate) || Number.isFinite(country.hour));
    const ruleHasSeries = model.rules.length > 0;
    const wanHasSeries = Number.isFinite(model.wan.rate) || Number.isFinite(model.wan.hour);
    const mapped = placeCountries(topCountries(model.countries, 'hour', 12));
    onTraffic(mapped.placed);
    $('mapnote').textContent = mapped.unplaced ? `+${mapped.unplaced} unplaced` : '';

    const threatState = chooseFeedState({
      error: model.countryError || model.ruleError || model.wanError,
      hasSeries: countryHasSeries || ruleHasSeries || wanHasSeries,
      hasLastGood: model.countryStaleData || model.ruleStaleData || model.wanStaleData,
    });
    setState($('threat'), threatState.state, threatState.message);

    const rates = model.countries.filter((country) => Number.isFinite(country.rate));
    const hours = model.countries.filter((country) => Number.isFinite(country.hour));
    // WAN totals come from every denied WAN event; country sums only from events with a known country.
    const currentRate = Number.isFinite(model.wan.rate) ? model.wan.rate
      : rates.length ? rates.reduce((sum, country) => sum + country.rate, 0) : null;
    const hourTotal = Number.isFinite(model.wan.hour) ? model.wan.hour
      : hours.length ? hours.reduce((sum, country) => sum + country.hour, 0) : null;
    const distinctCountries = new Set(hours.map((country) => country.code)).size;
    const count = (value) => Number.isFinite(value) ? Math.round(value).toLocaleString('en') : '—';
    const rules = [...model.rules].sort((a, b) => b.value - a.value || a.labels.rule.localeCompare(b.labels.rule)).slice(0, 5);
    $('threat-content').innerHTML = `<div class="threat-stats">
      <div><b class="num">${esc(formatEventsPerMinute(currentRate))}</b><span>drops / min now</span></div>
      <div><b class="num">${esc(count(hourTotal))}</b><span>drops in 1 hour</span></div>
      <div><b class="num">${esc(count(hours.length ? distinctCountries : null))}</b><span>countries in 1 hour</span></div>
    </div>
    <div class="rule-list"><span class="section-label">Top deny rules / min</span>${rules.map((row) =>
      `<div class="rule-row"><span>${esc(row.labels.rule)}</span><b class="num">${esc(formatEventsPerMinute(row.value))}</b></div>`).join('')}</div>`;

    const blockedState = chooseFeedState({
      error: model.countryError,
      hasSeries: countryHasSeries,
      hasLastGood: model.countryStaleData,
    });
    renderBlocked(blockedState, topCountries(model.countries, 'rate', model.countries.length));
  }

  const resizeObserver = new ResizeObserver(render);
  resizeObserver.observe($('blocked'));
  onDispose(() => resizeObserver.disconnect());

  return async function refreshThreat() {
    const previousCountryGood = model.countryLastGood;
    const previousRuleGood = model.ruleLastGood;
    const previousWanGood = model.wanLastGood;
    const [countryResult, ruleResult, wanResult] = await Promise.allSettled([
      query(Q.mc2DropCountries), query(Q.mc2DenyRules), query(Q.mc2WanDrops),
    ]);
    model.wanError = wanResult.status === 'rejected' ? errorMessage(wanResult.reason) : '';
    model.wanStaleData = wanResult.status === 'rejected' && previousWanGood;
    if (wanResult.status === 'fulfilled') {
      model.wan = wanTotals(wanResult.value);
      model.wanLastGood = Number.isFinite(model.wan.rate) || Number.isFinite(model.wan.hour);
    }
    model.countryError = countryResult.status === 'rejected' ? errorMessage(countryResult.reason) : '';
    model.countryStaleData = countryResult.status === 'rejected' && previousCountryGood;
    if (countryResult.status === 'fulfilled') {
      model.countries = splitCountryWindows(countryResult.value);
      model.countryLastGood = model.countries.length > 0;
    }
    model.ruleError = ruleResult.status === 'rejected' ? errorMessage(ruleResult.reason) : '';
    model.ruleStaleData = ruleResult.status === 'rejected' && previousRuleGood;
    if (ruleResult.status === 'fulfilled') {
      model.rules = ruleResult.value.filter((row) => row.labels.rule && Number.isFinite(row.value));
      model.ruleLastGood = model.rules.length > 0;
    }
    render();
  };
}
