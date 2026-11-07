# homelab-wall

A 24/7 animated wall display for a homelab: a family of full-screen
"Mission Control" pages (three.js + canvas) and a rotator that cycles them with
other dashboards.

## Layout

| Path | What |
| --- | --- |
| `site/mc1/` | Nodes, storage, topology, app health, LLM status, firewall |
| `site/mc6/` | LEXICON: rotating hero word cloud and per-source clouds |
| `site/mc7/` | AI Benchmark Cockpit (beta): engine and router benchmarks |
| `site/mc8/` | Router Switchboard (beta): caller-to-model token paths |
| `site/mc9/` | Agent Constellation (beta): agent activity rates and 24h rings |
| `site/lib/` | Prometheus client, PromQL, app health score, stage/GL helpers |
| `site/vendor/`, `site/fonts/` | Vendored three.js, d3-cloud, and fonts |
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
instant rows or `[timestamp, value]` pairs in range `values`. Instant timestamps
are evaluation times; range timestamps are step times, including when replaying
an old snapshot.
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
MC8 uses real measurements only. Empty or failed queries show `Pending` until
the first reading; later gaps retain the last measurement with a visible
`STALE` age. An empty failure, fallback or spend result reads as zero while the
router is live. Zero token rate means idle; local share is unavailable when the
total is zero. Routes retain caller alias and team, model, and provider labels;
width means input plus output tokens/s over 5 minutes. Focus or hover a caller
or model to trace its paths. Failure flashes apply to model edges with measured
failure or failed-fallback increases over the last minute; those counters do
not establish caller attribution. Stale failure readings never trigger flashes.
Billing banks use the token series' `tag_telemetry_billing_class_` labels:
`local`, `subscription`, `paid`, and `free`, when their string value is `true`.
Series with all flags false or missing remain Unclassified; provider names
never determine billing. Rates retain these labels through aggregation.
Token-rate freshness uses the raw input and output counter sample times, grouped
by caller, team, model, provider and billing class. In-flight, TTFT, failure and
fallback freshness use their raw series' sample times; spend freshness uses
router liveness, since provider spend series exist only after use. Measurements
older than 5 minutes, more than 5 seconds ahead, or without a valid
timestamp are stale, even after a successful snapshot refresh. The unclassified
percentage has its own stale state from the same token-rate sample times.
Model failure markers also appear at zero token throughput; failure-only models
show No token rate rather than a made-up zero.
Local share uses classified token rates only, with the unclassified percentage
shown separately. Without classified traffic it shows Unavailable. Failure and
failed-fallback indicators cover the one-minute window that ends at each result's
evaluation time, and expire 75 seconds after it. Past 25 seconds the marker names
how long ago that window ended.
Time to first token p95 uses standard router histogram buckets; spend shows
OpenRouter cents since the UTC month boundary: each series' rise over its
month-start baseline, clamped at zero, then summed. Counter resets can still
undercount month-to-date spend, and the page says so.
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

## MC7 benchmark beta

`/mc7/` is an independent AI Benchmark Cockpit. Engine cards show decode and
prefill counter rates with timestamped, gap-preserving history, latency
percentiles, concurrency, cache usage, prefix hits, and speculative acceptance.
Router cards use LiteLLM `_bucket` histograms for TTFT p50/p95 and E2E p95,
aggregated per model. Engine histograms also use standard `_bucket` names.
Percentiles come from bucket increases over the trailing 5 minutes, which also
count a new series' first small bucket counts.

Missing measurements show `NO DATA`. A failed poll keeps each last measured
value with its source sample time, and the tooltip shows that time, not the
poll time. A reading shows `STALE` with its age once that source sample is more
than 5 minutes old, or when no source time is available. A held value keeps the
source time of its last measurement, and a reading unmeasured for an hour leaves
the page. A percentile has no row when its window holds no requests; it reads
`Idle` while its source is fresh.
Device watts use a 5-minute mean; tokens/joule divides the recorded hourly
generation rate by hourly mean power. These are device totals, shown only when
an engine exposes an accelerator association, not per-model power allocations.
The router is the only telemetry source for the MLX engine today; engine-level
cache and latency breakdowns remain unavailable there.

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
