import type { Page } from '@playwright/test';

// The hero canvas holds a faint radial haze (alpha 0.1 at most) under the words, which are drawn
// at alpha 0.8 or more. Counting pixels above alpha 128 therefore counts word pixels only, and
// their mean position says where on the canvas the words were drawn (0..1 on each axis).
export async function heroWordPixels(page: Page) {
  return page.locator('#cloudhero').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const { width, height } = canvas;
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 128) {
          count += 1;
          sumX += x;
          sumY += y;
        }
      }
    }
    return { count, cx: count ? sumX / count / width : 0, cy: count ? sumY / count / height : 0 };
  });
}

// The hero's drawn view as the page reports it through window.__mc6.drawn(): the view's name or
// 'CONVERGENCE', and each drawn word with its size, rank lightness, source mix and fill kind.
export async function drawnHero(page: Page) {
  return page.evaluate(() => {
    const hook = (window as unknown as { __mc6?: { drawn(): unknown } }).__mc6;
    return (hook?.drawn() ?? null) as { view: string; words: { text: string; size: number; x: number; y: number; angle: number; width: number; lightness: number; sources: string[]; fill: string }[] } | null;
  });
}

// One source with forty words, so the hero cloud is a blob around the middle of its box.
export const heroWords = Array.from({ length: 40 }, (_, i) => ({ source: 'user', word: `term${i}`, n: String(400 - i * 9) }));
