# MC1 · Mission Control

MC1 is the estate overview. It shows every configured node, the network topology, service health, storage, firewall
activity and the large language model (LLM) router, with a ribbon of recent LLM requests along the bottom. The header
title comes from `config.json` `title` and defaults to `HOMELAB`.

![MC1 Mission Control](screenshots/mc1.png)

## Panels

- Header: an estate health ring, a subtitle with node, group and app counts, six key figures and a clock.
  - The ring shows the lowest score among scored apps, so the estate never reads healthier than its worst app.
  - The key figures are guests (`config.json` `guestCount`), cores, memory in GB, raw storage in TB, apps, and
    24-hour uptime.
- Nodes: one card per node in `config.json` `nodeRoles`, then one card per `extraNodes` entry.
  - Each card shows central processing unit (CPU), memory and load gauges, a graphics processing unit (GPU) gauge,
    and a 30-minute CPU sparkline.
  - The card subtitle shows the role, the hottest temperature and the uptime in days.
  - A role that only repeats the node's own name is left out of the subtitle.
  - The panel title counts nodes up out of all nodes.
- Network fabric · topology: one cluster per `config.json` group, each labelled with its app count and health.
  - Overlays show wide area network (WAN) links, firewall event rates per virtual local area network (VLAN), a VLAN
    pulse strip, and counts of nodes up, apps scored, models up and the last update time.
  - On a software WebGL renderer the topology drops to a 2D mode, labelled `2D MODE`. `?gl=3d` or `?gl=2d` forces
    either.
- Service health: a honeycomb of every app in `config.json` `groups`, in group order, with one empty cell between
  groups.
  - An app listed in two groups appears in the first one.
  - Each cell shows the app's health score from 0 to 10.
  - The title counts apps OK (8 or more), DEGRADED (5 to under 8) and DOWN (under 5).
- Storage: up to 12 filesystems over 1 GB, largest first, each with host, pool or mount name, percent used and size.
  - A ZFS pool is counted once per host.
  - The same device and mountpoint reported by several hosts is one row, labelled `shared`.
  - Network and virtual filesystems are excluded by the query.
  - The title shows used and total TB.
- Firewall: two columns, `Blocked at the edge` and `Live firewall · flows`.
- LLM fabric: up to 9 router models, sorted by state, then output tok/s, then name.
  - Each row shows a state dot, the model name, a token-rate sparkline, output tok/s and the state `ok`, `degraded`
    or `outage`.
  - The title counts models up out of all models, plus their summed tok/s.
- LLM activity ribbon: the 24 newest router requests, newest first, scrolling along the bottom.
  - MC1's activity ribbon reads `/api/llm/recent` once per minute, using metadata only: `ts` (Coordinated Universal
    Time), `source`, `model`, `role`, and `chars`.
  - It accepts a row array or ClickHouse JSON's `data` array.
  - Size means exact characters, never tokens.
  - The feed has no per-request token counts, generation rate, or time to first token, so the ribbon does not
    display those measurements.
  - Pause stops its motion; reduced motion allows manual scrolling.

## Data

- `appScore`: the health score per app, for the honeycomb, the ring and the topology clusters.
- `uptime24h`: the percentage of successful health checks over 24 hours, for the uptime figure.
- `nodeCpu`: CPU busy percent per node. MC1 also reads it as a 30-minute range at 30-second steps for the sparkline.
- `nodeCores`: core count per node.
- `nodeMem`: memory used percent per node.
- `nodeMemTotal`: total memory per node.
- `nodeLoad`: the 1-minute load average per node.
- `nodeTemp`: the hottest hardware-monitor temperature per node.
- `nodeUptime`: seconds since boot per node.
- `acceleratorBusy`: busy percent per accelerator, averaged over 5 minutes. Every GPU gauge shows the busiest one.
- `fsSize`: filesystem size in bytes.
- `fsAvail`: filesystem free bytes.
- `llmState`: the router deployment state per model: 0 ok, 1 degraded, 2 outage.
- `llmTokRate`: output tok/s per model over 5 minutes.
- `vlanFwRate`: firewall events per second per VLAN over 5 minutes.

The ribbon reads `/api/llm/recent`, outside Prometheus. Its contract is in [the runtime contract](runtime-contract.md).

## States

- Pending:
  - MC1's GPU gauges are the exception to stand-in content. With no `accelerator:busy_percent:avg5m` reading they
    draw an empty gauge and the nodes panel is `pending` (`error` when the query fails), never a stand-in value.
  - An `extraNodes` entry with no exporter is a pending card. It shows its role and stand-in gauges.
  - The LLM fabric panel is `pending` until the router answers, and `error` when its query fails.
  - On the ribbon, no rows or no successful response yet shows `pending`.
- Idle: a model at 0.05 tok/s or less reads `idle`. A model in outage reads `DOWN`.
- STALE:
  - A node that drops out of a single poll shows a stale state instead of disappearing.
  - It keeps its last known values, dims, and is labelled `STALE <age>`, then `STALE since <time>` after about
    5 minutes.
  - The last known values survive a page reload.
  - The node set itself always comes from `config.json` (`nodeRoles` and `extraNodes`), never from whichever series
    a poll happens to return.
  - On the ribbon, rows older than 2 minutes, or retained after a failed refresh, show `STALE <age>`. After
    5 minutes this becomes `STALE since <time>`.
  - Successful empty responses clear the ribbon.
- Stand-in:
  - A panel whose source is not wired yet, or whose query comes back empty or fails, shows plausible stand-in
    content instead of a placeholder.
  - Nothing on screen marks it. A `data-source="stand-in"` attribute (plus `data-state` `empty`, `pending` or
    `error` for an empty or failed query) records it for automation only.
  - The firewall columns and the WAN overlay are always stand-in.
  - The VLAN rates are stand-in while `vlanFwRate` is empty.
  - The honeycomb, storage and LLM fabric use sample data while their query is empty or failed.
  - Each key figure uses a stand-in value while its own source is missing.
  - With some apps scored, an app with no score of its own draws as a red 0.
- NO DATA and Unavailable: not used on MC1.
