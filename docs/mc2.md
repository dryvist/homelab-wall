# MC2 · Edge

MC2 shows UniFi WAN firewall drops by source country. The title comes from `config.json` `title` and defaults to
`HOMELAB`.

![MC2 Edge](screenshots/mc2.jpg)

## Panels

- Globe: the existing full-viewport globe, home beacon, impact pulses and orbit ring. Up to 12 source countries with
  the largest one-hour counts draw arcs to the beacon. Arc brightness and particle speed use each country's current
  drop rate. The globe turns slowly toward the top origin country.
  - It draws in 3D on a hardware WebGL renderer and in 2D with `?gl=2d`.
  - `?gl=3d` or `?gl=2d` forces either mode.
  - Reduced motion holds particles still and stops the camera drift.
- Service health: a header strip that counts apps OK, DEGRADED and DOWN across every app in `config.json` `groups`.
- Edge // block telemetry: current drops per minute, drops in the last hour, distinct countries in the last hour, and
  up to five deny rules ranked by current rate.
- Blocked // live feed: countries ranked by current drops per minute, with country code, country name, rate per minute
  and one-hour count. The list fills the panel; an overflow row reports the number of remaining countries.

## Data

| Query key | PromQL | Use |
| --- | --- | --- |
| `appScore` | Existing shared app-health query | Service health strip |
| `mc2DropCountries` | Tagged union of the country rate and increase expressions below | Both edge panels and globe |
| `mc2DenyRules` | `sum by (rule) (rate(unifi_fw_events_total{action=~"deny\|reject"}[5m]))` | Deny rules in edge telemetry |
| `mc2WanDrops` | Tagged union of the rate and 1-hour increase of denied WAN events in `unifi_fw_events_total` | Drops per minute and per hour |

The country query returns two label windows so the page can use one allow-listed query for both requested readings:

```promql
label_replace(sum by (country_code, country) (rate(unifi_wan_drops_total[5m])), "window", "rate", "country_code", ".+")
or label_replace(sum by (country_code, country) (increase(unifi_wan_drops_total[1h])), "window", "hour", "country_code", ".+")
```

The query tags these rows `window="rate"` and `window="hour"`. The `window` label is removed from display data.
The rate is in events per second at the metric boundary and is multiplied by 60 for events per minute. The increase
is the one-hour event count. Both metrics are grouped by `country_code` and `country`, so worker labels do not create
duplicate country rows.

The globe uses an approximate centroid lookup for ISO 3166-1 alpha-2 codes, plus the commonly used `XK` code. Unknown
codes are omitted from the globe and counted as `+N unplaced`. Their metric rows remain in the panels. Geo-block-list
markers are not shown.

## States

- `ok`: one or more relevant metric series returned.
- `no-feed`: the country query returned no rows for the live list, or both MC2 queries returned no rows for telemetry.
  The panels show `No feed` and the globe draws no traffic arcs.
- `error`: a relevant query failed before a successful reading; the panel message contains the query error.
- `stale`: a relevant query failed after a reading; the last metric values remain visible with a `STALE` marker.
- Service health: missing app scores show `—`; with no scores, its state is `empty` and it reads `NO SERVICE DATA`, or
  `NO APPS CONFIGURED` when the groups list is empty. A failed query reads `SCORE QUERY FAILED`; prior scores remain
  visible in `stale` state.
- Pending, Idle, NO DATA and Unavailable: not used on MC2.
