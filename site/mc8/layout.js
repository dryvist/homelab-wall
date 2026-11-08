import { esc } from '/lib/stage.js';
import { BANKS, splitTopByRate } from './data.js';
import { formatPair } from './metrics.js';

const number = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function moreTerminal(kind, more) {
  const name = kind === 'models' ? [[more.localCount, 'local'], [more.cloudCount, 'cloud']]
    .filter(([count]) => count > 0).map(([count, bank]) => `+${count} ${bank}`).join(' · ') : `+${more.count} more`;
  return { id: `__more_${kind}__`, name, localRate: more.localRate, cloudRate: more.cloudRate, more: true, bank: 'unknown', metricId: null };
}

function terminal(node, kind, displayed) {
  const destinations = displayed.routes.filter((route) => kind === 'caller' ? route.caller === node.id : route.model === node.id).map((route) => {
    const other = (kind === 'caller' ? displayed.models : displayed.callers).find((item) => item.id === (kind === 'caller' ? route.model : route.caller));
    const name = kind === 'caller' && other ? `${other.name} (${BANKS[other.bank]?.title || 'Unclassified'})` : other?.name;
    return `${name}: ${formatPair(route.localRate, route.cloudRate, ' tokens/s')}`;
  }).join('; ');
  const rate = kind === 'caller' && node.pinned && !Number.isFinite(node.localRate) && !Number.isFinite(node.cloudRate)
    ? 'no requests yet' : kind === 'caller' || node.more ? formatPair(node.localRate, node.cloudRate, ' tokens/s')
      : node.rate == null ? 'No token rate' : `${number(node.rate)} t/s`;
  return `<div class="terminal${node.more ? ' more' : ''}" tabindex="0" data-kind="${kind}" data-id="${esc(node.id)}" title="${esc(destinations)}"><div><strong>${esc(node.name)}</strong>${node.team ? `<small>${esc(node.team)}</small>` : ''}${kind === 'model' ? '<small class="failure-marker"></small>' : ''}</div><span class="rate${kind === 'caller' || node.more ? ' split' : ''}">${rate}</span></div>`;
}

export function callerMarkup(split, displayed) {
  const rows = [...split.visible, ...(split.more ? [moreTerminal('callers', split.more)] : [])];
  return rows.length ? rows.map((caller) => terminal(caller, 'caller', displayed)).join('') : '<p class="no-feed">No caller rates yet</p>';
}

export function modelMarkup(split, displayed) {
  const groups = Object.entries(BANKS).map(([bank, style]) => {
    const models = split.visible.filter((model) => model.bank === bank);
    return models.length ? `<section class="bank" style="--bank:${style.color}"><h3>${style.title}</h3>${models.map((model) => terminal(model, 'model', displayed)).join('')}</section>` : '';
  }).join('');
  const more = split.more ? terminal(moreTerminal('models', split.more), 'model', displayed) : '';
  return groups + more || '<p class="no-feed">No measured routes</p>';
}

export function fitRows(container, rows, markup, mark = () => {}) {
  if (!rows.length) {
    const split = splitTopByRate(rows, 1);
    container.innerHTML = markup(split);
    return split;
  }
  const pinned = rows.filter((row) => row.pinned), ranked = rows.filter((row) => !row.pinned);
  const candidate = (limit) => {
    const split = splitTopByRate(ranked, limit);
    return { visible: [...pinned, ...split.visible], more: split.more };
  };
  let best = null, low = 1, high = ranked.length || 1;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2), split = candidate(limit);
    container.innerHTML = markup(split); mark(split);
    if (container.scrollHeight <= container.clientHeight) { best = split; low = limit + 1; }
    else high = limit - 1;
  }
  const split = best || candidate(1);
  container.innerHTML = markup(split);
  return split;
}

export function compactRoutes(routes, callers, models) {
  const callerIds = new Set(callers.map((caller) => caller.id)), modelIds = new Set(models.map((model) => model.id));
  const moreCaller = callers.find((caller) => caller.more)?.id, moreModel = models.find((model) => model.more)?.id;
  const compacted = new Map();
  for (const route of routes) {
    const caller = callerIds.has(route.caller) ? route.caller : moreCaller;
    const model = modelIds.has(route.model) ? route.model : moreModel;
    if (!caller || !model) continue;
    const id = JSON.stringify([caller, model, Number.isFinite(route.localRate) ? 'local' : 'cloud']);
    const current = compacted.get(id);
    if (current) {
      current.rate += route.rate;
      for (const bank of ['local', 'cloud']) if (Number.isFinite(route[`${bank}Rate`])) current[`${bank}Rate`] = (current[`${bank}Rate`] ?? 0) + route[`${bank}Rate`];
    } else compacted.set(id, { id, caller, model, rate: route.rate, localRate: route.localRate, cloudRate: route.cloudRate });
  }
  return [...compacted.values()];
}
