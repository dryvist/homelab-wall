import { loadConfig, onDispose, signalReady } from '../lib/stage.js';
import { guardRefresh } from '../lib/refresh.js';
import { loadBenchmarks, refreshFreshness, retainMeasurements } from './data.js';
import { renderBenchmarks } from './render.js';

const status = document.getElementById('status');
let latest = null;
let stopped = false;
let timer;
let freshnessTimer;
const REQUEST_TIMEOUT_MS = 10_000;

// The static shell is ready even when the first telemetry query is still pending.
requestAnimationFrame(signalReady);
onDispose(() => { stopped = true; clearTimeout(timer); clearInterval(freshnessTimer); });

async function start() {
  let cfg;
  let timeout;
  try {
    cfg = await Promise.race([
      loadConfig(),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS); }),
    ]);
  }
  catch {
    status.textContent = 'Configuration unavailable · retrying';
    timer = setTimeout(start, REQUEST_TIMEOUT_MS);
    return;
  }
  finally { clearTimeout(timeout); }
  if (!cfg) {
    status.textContent = 'Configuration unavailable · retrying';
    timer = setTimeout(start, REQUEST_TIMEOUT_MS);
    return;
  }
  const seconds = Number(cfg.refreshSeconds);
  const delay = (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 15) * 1000;
  function update() {
    if (!latest || stopped) return;
    latest = refreshFreshness(latest);
    renderBenchmarks(latest);
    status.textContent = latest.failed
      ? 'Telemetry incomplete · held readings keep their measured time'
      : latest.stale.size ? 'Telemetry stale · readings older than 5 minutes or measurement time unavailable'
      : `Last checked ${new Date(latest.checkedAt).toLocaleTimeString()} · ${delay / 1000}s refresh`;
  }
  let guardedRefresh;
  async function refresh() {
    try {
      const raw = await loadBenchmarks();
      if (stopped) return;
      latest = retainMeasurements(raw);
      update();
    } catch (error) {
      console.error('MC7 refresh failed', error);
      status.textContent = 'Telemetry refresh failed · retrying';
    } finally {
      if (!stopped) timer = setTimeout(guardedRefresh, delay);
    }
  }
  guardedRefresh = guardRefresh(refresh);
  freshnessTimer = setInterval(update, 1000);
  guardedRefresh();
}
start();

const redraw = () => { if (latest) renderBenchmarks(latest); };
window.addEventListener('resize', redraw);
onDispose(() => window.removeEventListener('resize', redraw));
const reloadId = setTimeout(() => location.reload(), 24 * 60 * 60 * 1000);
onDispose(() => clearTimeout(reloadId));
