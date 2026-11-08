import { adaptiveDpr, onDispose } from '/lib/stage.js';
import { BANKS, increased } from './data.js';

export function createWireDrawer(board, diagram, canvas, hub, ctx, motion) {
  let displayed = { callers: [], models: [], routes: [], hidden: [] }, feeds = {}, wires = [], selected = null;

  function draw(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const maximum = Math.max(...wires.map((wire) => wire.rate), 1);
    for (const wire of wires) {
      const { from, to, mid } = wire;
      if (!from || !to) continue;
      const active = !selected || wire[selected.kind] === selected.id;
      const model = displayed.models.find((item) => item.id === wire.model);
      const behind = model?.more ? displayed.hidden : model ? [model] : [];
      const failed = behind.some((item) => increased(feeds.mc8Failures, item.metricId));
      const fallback = behind.some((item) => increased(feeds.mc8Fallbacks, item.metricId));
      const flash = motion.matches || Math.floor(now / 450) % 2 === 0;
      ctx.strokeStyle = wire.color;
      ctx.globalAlpha = (active ? .65 : .06) * (board.dataset.state === 'stale' ? .35 : 1);
      ctx.lineWidth = 1 + 11 * wire.rate / maximum;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo((from.x + mid.x) / 2, from.y, (from.x + mid.x) / 2, mid.y, mid.x, mid.y); ctx.stroke();
      if (!motion.matches && board.dataset.state === 'ok') {
        ctx.save(); ctx.lineWidth = 1.5; ctx.globalAlpha = active ? .9 : .06;
        ctx.setLineDash([4, 26]); ctx.lineDashOffset = -now / 45; ctx.stroke(); ctx.restore();
      }
      ctx.strokeStyle = failed && flash ? '#ff7288' : fallback && flash ? '#ffb66b' : wire.color;
      ctx.beginPath(); ctx.moveTo(mid.x, mid.y);
      ctx.bezierCurveTo((to.x + mid.x) / 2, mid.y, (to.x + mid.x) / 2, to.y, to.x, to.y); ctx.stroke();
      if (!motion.matches && board.dataset.state === 'ok') {
        ctx.globalAlpha = active ? .9 : .06; ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 26]); ctx.lineDashOffset = -now / 45; ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function measure() {
    const box = diagram.getBoundingClientRect(), dpr = adaptiveDpr();
    canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const positions = new Map([...document.querySelectorAll('.terminal')].map((node) => {
      const rect = node.getBoundingClientRect();
      return [node.dataset.kind + node.dataset.id, { x: (node.dataset.kind === 'caller' ? rect.right : rect.left) - box.left, y: rect.top + rect.height / 2 - box.top }];
    }));
    const rect = hub.getBoundingClientRect();
    const midpoint = { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
    wires = displayed.routes.filter((route) => route.rate > 0).map((route) => ({ ...route,
      from: positions.get('caller' + route.caller), to: positions.get('model' + route.model), mid: midpoint,
      color: displayed.models.find((model) => model.id === route.model)?.more ? '#9bacbf'
        : BANKS[displayed.models.find((model) => model.id === route.model)?.bank]?.color || '#9bacbf',
    }));
    draw(performance.now());
  }

  const onFocus = (event) => {
    const node = event.target.closest('.terminal');
    selected = node ? { kind: node.dataset.kind, id: node.dataset.id } : null;
    draw(performance.now());
  };
  const onBlur = () => { selected = null; draw(performance.now()); };
  board.addEventListener('pointerover', onFocus); board.addEventListener('focusin', onFocus);
  board.addEventListener('pointerleave', onBlur); board.addEventListener('focusout', onBlur);
  onDispose(() => {
    board.removeEventListener('pointerover', onFocus); board.removeEventListener('focusin', onFocus);
    board.removeEventListener('pointerleave', onBlur); board.removeEventListener('focusout', onBlur);
  });
  return {
    update(nextFeeds, nextDisplayed) {
      feeds = nextFeeds; displayed = nextDisplayed; measure();
    },
    draw,
  };
}
