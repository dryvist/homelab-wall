// Shared by mc1 (hex honeycomb) and mc5 (app grid): orders apps by config.groups order (an app
// listed in two groups goes to the first one it appears in) and marks one empty gap cell between
// consecutive non-empty groups. No labels, no titles — the gap is the only separator.
export function groupedHexLayout(groups) {
  const seen = new Set();
  const groupCells = [];
  for (const g of groups || []) {
    const cells = [];
    for (const n of g.apps || []) {
      if (seen.has(n)) continue;
      seen.add(n);
      cells.push(n);
    }
    if (cells.length) groupCells.push(cells);
  }
  // null marks a gap cell; only between groups that actually contributed cells.
  return groupCells.flatMap((cells, i) => (i ? [null, ...cells] : cells));
}
