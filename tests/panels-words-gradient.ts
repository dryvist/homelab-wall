import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { mockFeeds } from './fixture';
import { wallUrl } from './panels-contract';
import { drawnHero } from './panels-words-helpers';

// A multi-source word turned 90 degrees: its gradient runs along the glyph, so the ink at the glyph's
// start and at its end differ in hue. The operator's cloud holds twenty words; the seventeenth
// ('shared90') is also held by codex, and every ninth tail word is set vertical, so this one is.
const rotatedWords = [
  ...Array.from({ length: 20 }, (_, i) => ({ source: 'user', word: i === 16 ? 'shared90' : `term${i}`, n: String(200 - i * 9) })),
  { source: 'codex', word: 'shared90', n: '50' },
];

test('mc6 paints a rotated multi-source word with a gradient along its glyph', async ({ page }) => {
  test.skip(!!wallUrl, 'forces the words feed against the fixture server only');
  await page.emulateMedia({ reducedMotion: 'reduce' }); // no idle breathing, so the glyph holds still
  await mockFeeds(page);
  await page.route('**/api/words', (r: Route) => r.fulfill({ json: { meta: [], data: rotatedWords, rows: rotatedWords.length } }));
  await page.goto('/mc6/');
  await expect(page.locator('[data-panel="lexicon"]')).toHaveAttribute('data-state', 'ok');
  const rotated = async () => {
    const drawn = await drawnHero(page);
    return drawn?.view === 'user' ? drawn.words.find((w) => w.text === 'shared90' && w.angle === 90) ?? null : null;
  };
  await expect.poll(async () => (await rotated()) !== null, { message: 'the operator view never drew the rotated shared word' }).toBe(true);
  const word = (await rotated())!;
  // Samples the canvas along the glyph's own axis, through its body at three heights, and keeps the
  // hue of each ink pixel by side: the start third of the glyph and the end third.
  const { startHue, endHue, startInks, endInks } = await page.evaluate(({ x, y, angle, width, size }) => {
    const canvas = document.getElementById('cloudhero') as HTMLCanvasElement;
    const box = document.getElementById('hero') as HTMLElement;
    const ctx = canvas.getContext('2d')!;
    const scale = canvas.width / box.clientWidth; // device pixels per CSS pixel
    const theta = (angle * Math.PI) / 180;
    const hueOf = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const start: number[] = [];
    const end: number[] = [];
    for (let i = 0; i <= 40; i += 1) {
      const lx = (i / 40 - 0.5) * 0.9 * width; // along the glyph, from its start to its end
      for (const k of [-0.25, -0.35, -0.45]) {
        const ly = k * size; // above the baseline, inside the glyph body
        const dx = lx * Math.cos(theta) - ly * Math.sin(theta);
        const dy = lx * Math.sin(theta) + ly * Math.cos(theta);
        const px = Math.round(canvas.width / 2 + scale * (x + dx));
        const py = Math.round(canvas.height / 2 + scale * (y + dy));
        const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
        if (a < 250 || Math.max(r, g, b) - Math.min(r, g, b) < 60) continue; // not glyph ink
        if (lx < -0.15 * width) start.push(hueOf(r, g, b));
        else if (lx > 0.15 * width) end.push(hueOf(r, g, b));
      }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((sum, v) => sum + v, 0) / xs.length : -1);
    return { startHue: mean(start), endHue: mean(end), startInks: start.length, endInks: end.length };
  }, { x: word.x, y: word.y, angle: word.angle, width: word.width, size: word.size });
  expect(Math.min(startInks, endInks), 'ink samples in each third of the glyph').toBeGreaterThanOrEqual(2);
  expect(Math.abs(startHue - endHue), 'hue difference between the start and end thirds (degrees)').toBeGreaterThan(15);
});

