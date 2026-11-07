const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const COARSE_POINTER = '(pointer: coarse)';
const RETURN_EASE = 0.18;
const RETURN_EPSILON = 0.001;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Pointer input is for a directly opened page only. The rotator embeds pages in iframes, where the
// pointer remains disabled so its page behavior and kiosk presentation do not change.
export function createPointer({ win = globalThis.window, matchMedia = win?.matchMedia?.bind(win) } = {}) {
  const pointer = { x: 0, y: 0, active: false };
  const dispose = () => {};
  if (!win || win.self !== win.top || !matchMedia
      || matchMedia(REDUCED_MOTION).matches || matchMedia(COARSE_POINTER).matches
      || typeof win.requestAnimationFrame !== 'function') return { pointer, dispose };

  let targetX = 0;
  let targetY = 0;
  let inside = false;
  let frame = null;
  let disposed = false;

  const schedule = () => {
    if (frame === null && !disposed) frame = win.requestAnimationFrame(update);
  };

  function update() {
    frame = null;
    pointer.active = inside;
    if (inside) {
      pointer.x = targetX;
      pointer.y = targetY;
    } else {
      pointer.x = Math.abs(pointer.x * (1 - RETURN_EASE)) < RETURN_EPSILON ? 0 : pointer.x * (1 - RETURN_EASE);
      pointer.y = Math.abs(pointer.y * (1 - RETURN_EASE)) < RETURN_EPSILON ? 0 : pointer.y * (1 - RETURN_EASE);
      if (pointer.x || pointer.y) schedule();
    }
  }

  function onPointerMove(event) {
    const width = Number.isFinite(win.innerWidth) && win.innerWidth > 0 ? win.innerWidth : 1;
    const height = Number.isFinite(win.innerHeight) && win.innerHeight > 0 ? win.innerHeight : 1;
    const clientX = Number.isFinite(event.clientX) ? event.clientX : width / 2;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : height / 2;
    targetX = clamp((clientX / width) * 2 - 1, -1, 1);
    targetY = clamp(1 - (clientY / height) * 2, -1, 1);
    inside = true;
    schedule();
  }

  // pointerleave never reaches window; a pointerout with no related target means the pointer left the page.
  function onPointerOut(event) {
    if (event.relatedTarget) return;
    inside = false;
    schedule();
  }

  win.addEventListener('pointermove', onPointerMove, { passive: true });
  win.addEventListener('pointerout', onPointerOut);

  return {
    pointer,
    dispose() {
      disposed = true;
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerout', onPointerOut);
      if (frame !== null) win.cancelAnimationFrame?.(frame);
      frame = null;
    },
  };
}
