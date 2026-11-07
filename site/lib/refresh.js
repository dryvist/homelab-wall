// A hung refresh blocks every later tick, so each request it awaits must have its own timeout.
export function guardRefresh(refresh) {
  let refreshing = false;
  return async (...args) => {
    if (refreshing) return;
    refreshing = true;
    try {
      return await refresh(...args);
    } finally {
      refreshing = false;
    }
  };
}
