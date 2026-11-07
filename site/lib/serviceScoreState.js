export function serviceScoreState(queryFailed, hasScores) {
  if (queryFailed) return hasScores ? 'stale' : 'error';
  return hasScores ? 'ok' : 'empty';
}
