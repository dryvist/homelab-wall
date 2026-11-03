# homelab-wall

A 24/7 animated wall display for a homelab: a family of full-screen
"Mission Control" pages (three.js + canvas) and a rotator that cycles them with
other dashboards.

## Layout

| Path | What |
| --- | --- |
| `site/mc1/` | Mission Control 1: nodes, storage, 3D topology, app health honeycomb, LLM status, firewall feeds |
| `site/lib/` | Shared Prometheus client, PromQL (including the app health score), stage/GL helpers |
| `site/vendor/`, `site/fonts/` | three.js and fonts, vendored so no page loads code or fonts from the internet |
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
```

Releases attach `homelab-wall-site.tar.gz`, which the deploy role fetches at a
pinned version.

## License

Apache-2.0. See [LICENSE](LICENSE).
