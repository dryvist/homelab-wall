# MC1 · Mission Control

MC1 is the estate overview. It shows configured nodes, a full-page network topology behind the panels, service health,
storage, WAN rates and the large language model (LLM) router, with recent LLM requests along the bottom. The header
title comes from `config.json` `title` and defaults to `HOMELAB`.

![MC1 Mission Control](screenshots/mc1.jpg)

## Panels

- Header: an estate health ring, a subtitle with node, group and app counts, six key figures and a clock.
  - The ring shows the lowest score among scored apps, so the estate never reads healthier than its worst app.
  - The key figures are guests (`config.json` `guestCount`), cores, memory in GB, raw storage in TB, apps, and
    24-hour uptime.
- Nodes: one card per node in `config.json` `nodeRoles`, in reverse name order, then one card per `extraNodes` entry.
  - Each card shows central processing unit (CPU), memory and load gauges, a graphics processing unit (GPU) gauge,
    and a 30-minute CPU sparkline.
  - Each node has its own GPU gauge. Once GPU inventory is available, a node with no GPU shows `NO GPU`.
  - The card subtitle shows the role, the hottest temperature and the uptime in days.
  - A role that only repeats the node's own name is left out of the subtitle.
  - The panel title counts nodes up out of all nodes.
- Network fabric · topology: a gateway at the center, switches and access points on an inner ring, VLAN hubs near
  the access device carrying the most combined client bytes, and an Internet node on the WAN link.
  - Each network and VLAN pair with client traffic has one hub. A VLAN without device attribution connects to the
    gateway. Every returned VLAN remains in the model and the `#vlanrates` list.
  - Configured groups attach to a matching VLAN hub. Matching lowercases names, removes spaces, hyphens and
    underscores, then applies aliases for `mgmt`, `svc`/`svcs`, `prod`, `dev` and `infra`. Unmatched groups remain
    application hubs.
  - VLAN-to-access-device, access-device-to-gateway and gateway-to-Internet edges use their measured byte rates.
    Moving particles appear only when those rates are positive; particle density and speed follow the rates.
  - When inter-network firewall flow series exist, the highest event-rate VLAN pairs add arcs. Accepted arcs use
    the source hub color and denied arcs use red. The graph rotates slowly in WebGL and 2D modes.
  - Labels show VLAN RX/TX Mbps, device throughput Mbps, and configured group app counts and health. On a software
    WebGL renderer the topology uses its 2D mode, labelled `2D MODE`. `?gl=3d` or `?gl=2d` forces either.
- Service health: a honeycomb of every app in `config.json` `groups`, in group order, with one empty cell between
  groups.
  - An app listed in two groups appears in the first one.
  - Each cell shows the app's health score from 0 to 10.
  - The title counts apps OK (8 or more), DEGRADED (5 to under 8) and DOWN (under 5).
- Storage: pool and filesystem rows, largest first, each with node, pool or mount name, percent used and size.
  - A pool is counted once per node.
  - The same device and mountpoint reported by several nodes is one row, labelled `shared`.
  - Network and virtual filesystems are excluded by the query.
  - All pools are included. If the rows do not fit, the panel shows a `+N more` count.
  - Sizes from 900 GB through 1 TB display as `1T`.
  - The title shows used and total TB.
- Firewall: `Blocked at the edge` lists WAN drop rates by country; `Live firewall · flows` lists inter-network
  flow rates and rule event rates. Rates display as events per minute. Each column fills the panel height with the
  highest-rate rows first. Empty series show `No feed`; query failures show their error message.
- LLM fabric: up to 9 router models, sorted by state, then output tok/s, then name.
  - It lists only models with real requests in the last 4 days. The router's own health-check caller does not count.
  - When that query fails, it lists every deployment instead.
  - Each row shows a state dot, the model name, a token-rate sparkline, output tok/s and the state `ok`, `degraded`
    or `outage`.
  - The title shows local and cloud model counts and rates separately.
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
- `pveStorageUsed`: pool usage by storage identifier.
- `llmState`: the router deployment state per model: 0 ok, 1 degraded, 2 outage.
- `llmUsed4d`: models with a real request in the last 4 days. Only these models get a row.
- `llmTokRate`: output tok/s per model over 5 minutes.
- `wanRxBytes` and `wanTxBytes`: receive and transmit byte rates from the WAN counters.
- `vlanRxBytes` and `vlanTxBytes`: client receive and transmit byte rates, grouped by network, VLAN, switch and
  access point.
- `deviceInfo`: UniFi device name, model and type. Gateway types are `udm` and `ugw`, switches are `usw`, and access
  points are `uap`.
- `deviceRxBytes` and `deviceTxBytes`: measured device receive and transmit byte rates by device name.
- `fwFlowEvents`: accepted and denied firewall event rates by incoming network, outgoing network and action. The
  worker dimension is summed away.
- `fwWanDrops`: denied WAN event rates by country code and country. The worker dimension is summed away.
- `fwRuleEvents`: firewall rule event rates by rule and action. The worker dimension is summed away.

The ribbon reads `/api/llm/recent`, outside Prometheus. Its contract is in [the runtime contract](runtime-contract.md).

## States

- Pending:
  - A node without current metrics keeps its card and shows pending or its last real values as stale.
  - Missing GPU readings show `—`; a node without a GPU shows `NO GPU`.
  - The LLM fabric is pending until readings arrive and shows its query message when a query fails.
- Idle: a model at 0.05 tok/s or less reads `idle`. A model in outage reads `DOWN`.
- STALE:
  - A node that drops out of a single poll shows a stale state instead of disappearing.
  - It keeps its last known values, dims, and is labelled `STALE <age>`, then `STALE since <time>` after about
    5 minutes.
  - The last known values survive a page reload.
  - The node set itself always comes from `config.json` (`nodeRoles` and `extraNodes`), never from whichever series
    a poll happens to return.
  - Ribbon rows retained after a failed refresh, or older than 2 minutes, show `STALE <age>`. After 5 minutes this
    becomes `STALE since <time>`.
  - Successful empty responses clear the ribbon.
- Missing data: cells and figures without a reading show `—`; an app without a score does not draw a score.
- Query failures: panels show their visible query message. Firewall query failures set the firewall panel to error;
  successful empty firewall responses leave it in no-feed.
- NO DATA and Unavailable: not used on MC1.
