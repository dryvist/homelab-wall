# Runtime contract

The pages are static. Everything they read comes from their own origin, except MC5, which calls the public GitHub
application programming interface (API). This page states what a deployment must serve.

## Files a deployment serves

- The release tarball `homelab-wall-site.tar.gz` holds the contents of `site/` at its root. Each release also
  attaches `homelab-wall-site.tar.gz.sha256`.
- `/config.json`: written by the deployment. Every page reads it at start.
- `/api/prom/query` and `/api/prom/query_range`: a read-only Prometheus gateway, for live mode.
- A snapshot file at the path `config.json` names, for snapshot mode. A deployment uses live mode or snapshot mode.
- `/api/words`: word counts for MC6.
- `/api/llm/recent`: recent request metadata for MC1 and MC3.

## config.json

- `title`: the header title on MC1, MC2, MC4 and MC5. It defaults to `HOMELAB`.
- `refreshSeconds`: how often each page polls. It defaults to 15.
- `groups`: a list of `{"name": "...", "apps": ["..."]}`. Each app name matches the `name` label of its health-check
  series.
- `nodeRoles`: a map of node name to role, for MC1. It sets the node cards and their order.
- `extraNodes`: a list of `{"name": "...", "role": "..."}`, for MC1 nodes with no exporter.
- `guestCount`: the guests figure on MC1.
- `accelerators`: a map of accelerator role to display name, for MC3's device nodes.
- `slides`, `holdSeconds` and `reloadMinutes`: rotator settings, described in [the rotator page](rotator.md).
- `snapshot`: the path of a snapshot file. Setting it selects snapshot mode.

## Queries

Query results come from one of two sources, selected by `config.json`.

- Live (default): `/api/prom/query` and `/api/prom/query_range`, a read-only Prometheus gateway.
  - A request passes `query`, plus `start`, `end` and `step` for a range.
  - The response matches the Prometheus HTTP API: `{"status": "success", "data": {"result": [...]}}`.
  - Any other status, or a non-200 response, is a failed query.
- Snapshot: when `config.json` sets `"snapshot": "<path>"`, results come from that one static snapshot file instead,
  refreshed every 2s and keyed by `site/lib/queries.js`'s `Q`.
  - No request reaches `/api/prom` in snapshot mode.
  - A query whose key is missing from the snapshot fails, and only its panel shows that.

### The allow-list

- `site/lib/queries.js` exports `Q`, a map from key to Prometheus Query Language (PromQL) expression.
- Every query a page sends is a `Q` expression.
- `node scripts/gen-queries.mjs` regenerates the committed `site/queries.json` allow-list from `Q` whenever it
  changes.
- Continuous integration (CI) fails when `site/queries.json` does not match `Q`.
- A gateway behind `/api/prom` can refuse any expression that is not a value in `site/queries.json`.

### The feed publisher

The feed publisher produces snapshot mode's file. Its contract:

- It polls exactly the queries in `site/queries.json`.
- It writes one entry per `Q` key, never per raw expression.
- Instant results go under `instant`, and range results under `range`.
- Each entry is `{"result": [...]}`, in Prometheus's own vector or matrix shape.

```json
{
  "instant": {"appScore": {"result": [{"metric": {"name": "alpha"}, "value": [1767225600, "9"]}]}},
  "range": {"nodeCpu": {"result": [{"metric": {"instance": "node-a"}, "values": [[1767225600, "12"]]}]}}
}
```

### The shared client

`site/lib/prom.js` is the one client every page uses.

- The shared client keeps `query(expr)` rows as `{labels, value}` and `range(expr, minutes, stepSeconds)` rows as
  `{labels, values: [number]}`.
- Pass `{timestamps: true}` as the final argument to include `timestamp` in instant rows or `[timestamp, value]`
  pairs in range `values`.
- Instant timestamps are evaluation times; range timestamps are step times, including when replaying an old
  snapshot.
- Range also accepts `{align: true}` to floor the live request's end to a step boundary; it keeps the requested
  duration and leaves snapshot samples intact.
- Range also accepts `{bounds: {start, end}}` to fix a live request's window.
- `settle()` runs a set of queries and yields `null` for each one that failed, so only that panel is affected.
- Live queries and the snapshot fetch time out after 10 seconds. A timed-out query counts as failed.
- `site/lib/refresh.js` `guardRefresh` skips an interval tick while the previous refresh is still running.
- Run the client tests offline with `node --test 'tests/*.test.js' 'tests/*.test.mjs'`.

## Other feeds

- `/api/words`, for MC6: ClickHouse `FORMAT JSON`, `{"meta": [...], "data": [{"source", "word", "n"}], "rows": N}`.
  - `n` is a UInt64 serialized as a string.
- `/api/llm/recent`, for MC1 and MC3: a row array, or ClickHouse JSON with the rows in `data`.
  - Each row has `ts`, `source`, `model`, `role` and `chars`, and no message content.
  - `ts` is a timestamp in Coordinated Universal Time, or an ISO 8601 time with its offset.
  - `chars` is a non-negative whole number, or a string of digits.
  - MC1 drops a row that is dated in the future or is missing a field.
- The public GitHub API, for MC5: the browser calls it directly, with no token. See [MC5](mc5.md).

## Health score

`site/lib/queries.js` holds the one definition of the app health score, `APP_HEALTH_SCORE`.

- Each app scores from 0 to 10, from its health-check results in the `gatus_results_total` series.
- Only series whose `group` label has the form `<category> · UI` or `<category> · API` count.
- An app scores 10 when every check over the last 30 days succeeded.
- Otherwise it scores 9 times its 24-hour success ratio, rounded and capped at 9.
- `appScore` prefers a precomputed `homelab:app_health_score` series when one exists, and falls back to the inline
  expression.
- Pages read 8 or more as OK, 5 to under 8 as DEGRADED, and under 5 as DOWN.
- Colour runs red to green through the hue wheel.

## Panel states

- Each panel records its state in `data-state`: `ok`, `empty`, `pending`, `error` or `stale`.
- A panel whose source is not wired yet, or whose query comes back empty or fails, shows plausible stand-in content
  instead of a placeholder.
- Nothing on screen marks it: a `data-source="stand-in"` attribute (plus `data-state` `empty`, `pending` or `error`
  for an empty or failed query) records it for automation only.
- MC1 to MC5 use stand-in content. MC6 to MC9 never do.
- A panel's visible message appears only in state `ok`.
- Each page's own states are on its page: [MC1](mc1.md), [MC2](mc2.md), [MC3](mc3.md), [MC4](mc4.md), [MC5](mc5.md),
  [MC6](mc6.md), [MC7](mc7.md), [MC8](mc8.md) and [MC9](mc9.md).

## Rendering

- Pages check for a hardware WebGL renderer.
- On a software WebGL renderer, MC1 to MC5 draw their 3D scenes in 2D.
- `?gl=3d` or `?gl=2d` forces either.
- Under heavy load, MC2 to MC6 lower their own render quality in steps: pixel ratio first, then bloom, then a cap
  of 30 frames per second. They step back up when frames are light again.
- A page taller than the viewport scrolls itself down and back up, except under reduced motion.
- `site/lib/pointer.js` gives MC2, MC3 and MC4 a bounded mouse offset on their camera.
  - It runs only on a top-level page with a fine pointer and motion allowed, so a rotator slide never uses it.
  - The offset eases back to zero when the pointer leaves the page.
- `refreshSeconds` sets each page's poll interval. MC1 to MC7 also reload themselves every 24 hours.
