# MC2 · Edge

MC2 is the edge threat map. A full-screen globe with animated arcs sits behind a service health strip and two edge
panels. The header title comes from `config.json` `title` and defaults to `HOMELAB`.

![MC2 Edge](screenshots/mc2.png)

## Panels

- Globe: a full-viewport globe with a land mask, great-circle arcs that land on a home beacon, impact pulses and an
  orbit ring.
  - It draws in 3D on a hardware WebGL renderer and as a 2D wireframe on a software renderer.
  - `?gl=3d` or `?gl=2d` forces either.
  - Reduced motion stops the arcs and the camera drift, and slows the blocked list.
- Service health: a header strip that counts apps OK, DEGRADED and DOWN across every app in `config.json` `groups`.
- Edge // block telemetry: blocked today, unique sources and top sources.
- Blocked // live feed: a scrolling list of blocked sources.

## Data

- `appScore`: the health score per app, for the service health strip.

The globe and the two edge panels have no data source.

## States

- Stand-in:
  - The globe, the edge stats and the blocked list are always stand-in content.
  - They are decoration only and never show measured block data.
  - The two edge panels carry `data-source="stand-in"` with state `ok`. Nothing on screen marks them.
- Service health:
  - With no scored app, the strip counts sample scores, marked `data-source="stand-in"`, and records state `empty`.
  - With no apps configured, the strip records state `empty`.
- Pending, Idle, STALE, NO DATA and Unavailable: not used on MC2.
