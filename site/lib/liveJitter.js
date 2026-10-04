// Shared "never frozen" helper (site/lib/lastGood.js holds the value; this animates around it).
// A panel meant to look live must keep visibly changing between real samples, even when the
// source returns the same value or nothing at all. Two primitives cover every case in this repo
// (MC1 VLAN/flow, MC2 threat arcs/blocks, MC3 request feed): ONE place, reused everywhere instead
// of each page hand-rolling its own setTimeout/Math.random jitter loop.

// A rate of 0 would never schedule again — floor it so a genuinely-idle source still ticks
// slowly rather than going fully static.
const MIN_RATE_PER_SEC = 0.05;

// Fires `onFire()` at Poisson-process inter-arrival times (the actual definition: exponentially
// distributed gaps) around whatever `getRatePerSec()` currently returns. `getRatePerSec` is read
// fresh on every tick, never captured once, so a panel updating its held last-good rate
// (lastGood.js) takes effect on the very next event instead of after a restart. Returns a stop()
// to unregister — call it from onDispose (site/lib/stage.js).
export function poissonLoop(getRatePerSec, onFire) {
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const rate = Math.max(MIN_RATE_PER_SEC, getRatePerSec() || 0);
    const gapSec = -Math.log(1 - Math.random()) / rate; // exponential inter-arrival time
    timer = setTimeout(() => { onFire(); tick(); }, gapSec * 1000);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// Perturbs a displayed numeric rate by a random +/-`spread` fraction — for a continuous value
// (VLAN pkt/s, a sparkline bar) that has no discrete "event" of its own but must still read as
// alive from one redraw to the next rather than sitting on the exact same pixels.
export function jitterRate(rate, spread = 0.35) {
  return Math.max(0, rate * (1 + (Math.random() * 2 - 1) * spread));
}
