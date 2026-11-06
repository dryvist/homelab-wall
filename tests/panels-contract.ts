import pendingJson from './expected-pending.json' with { type: 'json' };

export const pending = pendingJson as { panels: Record<string, string[]>; queries: string[] };
export const PAGES = [
  { id: 'mc1', path: '/mc1/' },
  { id: 'mc2', path: '/mc2/' },
  { id: 'mc3', path: '/mc3/' },
  { id: 'mc4', path: '/mc4/' },
  { id: 'mc5', path: '/mc5/' },
  { id: 'mc6', path: '/mc6/' },
] as const;
export const MODES = ['2d', '3d'] as const;
export const invalidMetric = /NaN|undefined|null|Infinity|—/;
export const wallUrl = process.env.WALL_URL;
