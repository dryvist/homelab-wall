# homelab-wall

A 24/7 animated wall display for a homelab: a family of full-screen
"Mission Control" pages (three.js + canvas) and a rotator that cycles them with
other dashboards.

## Layout

| Path | What |
| --- | --- |
| `site/mc1/` | Mission Control 1: nodes, storage, 3D topology, app health honeycomb, LLM status, firewall feeds |
| `site/lib/` | Shared Prometheus client, PromQL (including the app health score), stage/GL helpers |
| `site/vendor/`, `site/fonts/` | three.js and fonts, vendored so the page loads nothing from the internet |
| `tests/` | Playwright at 1920×1080 against synthetic data |

## Runtime contract

The page is static. It reads two things from its own origin:

- `/config.json`: title, app groups, node roles, rendered by the deploying role.
- `/api/prom/query` and `/api/prom/query_range`: a read-only Prometheus gateway
  (see `homelab-wall-feed`).

Sources that are not wired yet show a "pending" state rather than disappearing.
A node that drops out of a single poll shows a "stale" state instead of
disappearing: it keeps its last known values, dims, and is labeled "STALE
&lt;age&gt;", then "NO DATA since &lt;time&gt;" after about 5 minutes. The node set
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

Open `/mc1/` full screen on a 1920×1080 display. The page refreshes its data
every `refreshSeconds` (config, default 15) and reloads itself nightly.

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
