# homelab-wall

A 24/7 animated wall display for a homelab: a family of full-screen
"Mission Control" pages (three.js + canvas) and a rotator that cycles them with
other dashboards.

## Layout

| Path | What |
| --- | --- |
| `site/mc1/` | Nodes, storage, topology, health, LLM, and firewall feeds |
| `site/mc3/` | AI Core: engine benchmarks, router averages, device energy |
| `site/mc6/` | LEXICON: source word clouds, cycling every 8 s |
| `site/lib/` | Shared Prometheus client, PromQL, stage/GL helpers |
| `site/vendor/`, `site/fonts/` | Offline three.js, d3-cloud, and fonts |
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

MC6 reads `GET /api/words` (same origin), ClickHouse `FORMAT JSON`:

```json
{
  "meta": [],
  "data": [{"source": "user", "word": "deploy", "n": "412"}],
  "rows": 1
}
```

`n` is a UInt64 serialized as a string. Every known source keeps a tile even
when the feed has no rows for it — an explicit NO FEED state; a feed that
fails keeps its last good clouds and shows the stale indicator.

A panel outside MC3 whose source is not wired yet, or whose query is empty or
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
On a software WebGL renderer the topology drops to a 2D mode; `?gl=3d` or
`?gl=2d` forces either.

## MC3 benchmark beta

MC3's benchmark beta reads engine counter rates and 10-minute range sparklines.
vLLM percentiles use its base-name histograms. Router TTFT, output token latency,
queue, and API averages show `NO DATA · router averages pending ingest fix` until
summary ingestion is repaired. Token rates use counters; sparklines retain sample
timestamps within the requested window and break across missing intervals.
Missing engine, cache, or power measurements show `NO DATA`. Device watts are a
5-minute mean; device tokens/joule divides the recorded hourly generation rate by
hourly mean power. These device totals are not per-model power allocations.
MC3 never substitutes sample models, KPI values, or seeded sparkline history.

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
```

Releases attach `homelab-wall-site.tar.gz`, which the deploy role fetches at a
pinned version.

## License

Apache-2.0. See [LICENSE](LICENSE).
