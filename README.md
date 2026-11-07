# homelab-wall

A 24/7 animated wall display for a homelab: a family of full-screen
"Mission Control" pages (three.js + canvas) and a rotator that cycles them with
other dashboards.

## Layout

| Path | What |
| --- | --- |
| `site/mc1/` | Mission Control 1: nodes, storage, 3D topology, app health honeycomb, LLM status, firewall feeds |
| `site/mc6/` | Mission Control 6 (LEXICON): a hero word cloud cycling the sources every 8 s plus a strip with one small cloud per source |
| `site/mc9/` | Mission Control 9 (beta): independent agent constellation, measured activity rates, and 24h activity rings |
| `site/lib/` | Shared Prometheus client, PromQL (including the app health score), stage/GL helpers |
| `site/vendor/`, `site/fonts/` | three.js, d3-cloud and fonts, vendored so no page loads code or fonts from the internet |
| `tests/` | Playwright at 1920×1080 against fixture data |

## Runtime contract

The pages are static. They read two things from their own origin:

- `/config.json`: title, app groups, node roles, rendered by the deploying role.
- Query results come from one of two sources, selected by `config.json`:
  - live (default): `/api/prom/query` and `/api/prom/query_range`, a read-only
    Prometheus gateway (see `homelab-wall-feed`).
  - snapshot: when `config.json` sets `"snapshot": "<path>"`, results come from
    that one static snapshot file instead, refreshed every 2s and keyed by
    `site/lib/queries.js`'s `Q`. `scripts/gen-queries.mjs` regenerates the
    committed `site/queries.json` allow-list from `Q` whenever it changes.

MC5 also calls the public GitHub API (`https://api.github.com`) straight from
the browser, with no token, for an organization's events, repositories and
releases.

The shared client keeps `query(expr)` rows as `{labels, value}` and
`range(expr, minutes, stepSeconds)` rows as `{labels, values: [number]}`.
Pass `{timestamps: true}` as the final argument to include `timestamp` in
instant rows or `[timestamp, value]` pairs in range `values`. Timestamps are
seconds from the source samples, including when replaying an old snapshot.
Range also accepts `{align: true}` to floor the live request's end to a step
boundary; it keeps the requested duration and leaves snapshot samples intact.
Run the client tests offline with `node --test tests/*.test.js`.

MC6 reads `GET /api/words` (same origin), ClickHouse `FORMAT JSON`:
`{"meta": [...], "data": [{"source": "user", "word": "deploy", "n": "412"}, ...], "rows": N}`.
`n` is a UInt64 serialized as a string. Every known source keeps a tile even
when the feed has no rows for it — an explicit NO FEED state; a feed that
fails keeps its last good clouds and shows the stale indicator.

MC9 uses only the Prometheus gateway or snapshot, with `mc9*` queries in `Q`.
Codex groups `session_source` into primary and `subagent_*` activity; Claude
Code groups `agent_name` into main (including an absent label) and subagents.
Both show output tokens/s. Donna shows router requests/s for its key alias;
Hindsight shows operations/s. The LLM spans node consumes the trace pipeline's
`traces_span_metrics_calls_total` with a generative AI model or system label.
That source is pending until span metrics arrive. Hermes gateway and cron
remain pending until their event counter names are confirmed; the available
prefix inventory alone does not define an activity counter.

MC9 never substitutes sample values. Missing signals stay visible as pending;
a signal that disappears or fails retains its last measured value as STALE.
Zero means a measured idle rate. Node area grows monotonically with the 5m
rate, approaching its ring; signals have different units and are labelled.
Rings show measured 5m rates over 24h (brightness relative to each node's own
maximum), with timestamp gaps unfilled. History refreshes every 5 minutes;
current rates follow `refreshSeconds`. Last seen is the end of the last
positive activity window, with 5-minute resolution for historical samples;
it is unknown when no activity was observed. Lines show agent grouping only.
Requests time out after 10 seconds. Current readings become stale after
300 seconds even during an unfinished poll. History becomes stale when its
newest sample is over 10 minutes old (allowing for refresh and alignment);
an empty 24h ring is pending, and expired retained history is also stale.
No host, session, or user identities appear. Pause and reduced motion stop
glow animation. The default rotator includes MC9 immediately after MC6.

A panel whose source is not wired yet, or whose query comes back empty or
fails, shows plausible stand-in content instead of a placeholder. Nothing on
screen marks it: a `data-source="stand-in"` attribute (plus `data-state`
`empty`, `pending` or `error` for an empty or failed query) records it for
automation only. MC1's GPU gauges are the exception: with no
`accelerator:busy_percent:avg5m` reading they draw an empty gauge and the
nodes panel is `pending` (`error` when the query fails), never a stand-in
value.
A node that drops out of a single poll shows a "stale" state instead of
disappearing: it keeps its last known values, dims, and is labeled "STALE
&lt;age&gt;", then "STALE since &lt;time&gt;" after about 5 minutes. The node set
itself always comes from `config.json` (`nodeRoles` + `extraNodes`), never
from whichever series a poll happens to return.
MC1's activity ribbon reads `/api/llm/recent` once per minute, using metadata
only: `ts` (UTC), `source`, `model`, `role`, and `chars`. It accepts a row array
or ClickHouse JSON's `data` array. Size means exact characters, never tokens.
No rows or no successful response yet shows `pending`. Rows older than 2
minutes, or retained after a failed refresh, show `STALE <age>`; after 5
minutes this becomes `STALE since <time>`. Successful empty responses clear
the ribbon. Pause stops its motion; reduced motion allows manual scrolling.
The feed has no per-request token counts, generation rate, or time to first
token, so the ribbon does not display those measurements.
On a software WebGL renderer the topology drops to a 2D mode; `?gl=3d` or
`?gl=2d` forces either.

## Health score

`site/lib/queries.js` holds the one definition of the 0–100 app health score:
24 h success ratio squared × a latency factor (p95 over 250 ms loses up to half)
× current up. Colour runs red → green through the hue wheel.

## Installation

The deploy role downloads `homelab-wall-site.tar.gz` from a pinned release and
serves it as static files behind the gateway from `homelab-wall-feed`.

## Usage

Open `/` full screen on a 1920×1080 display: the rotator cycles the Mission
Control pages (or `config.json`'s `slides`). Each page refreshes its data every
`refreshSeconds` (config, default 15). The rotator reloads the whole wall every
`reloadMinutes` (config, default 60, clamped to 5–1440) once the origin is
serving; a page opened on its own, such as `/mc1/`, reloads itself every 24
hours.

## Develop

```sh
direnv allow
npm ci
npx playwright install chromium
npx playwright test
node --test
```

Releases attach `homelab-wall-site.tar.gz`, which the deploy role fetches at a
pinned version.

## License

Apache-2.0. See [LICENSE](LICENSE).
