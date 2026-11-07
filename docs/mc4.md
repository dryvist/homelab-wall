# MC4 · Media

MC4 is the media acquisition page. A 3D acquisition flow fills the screen behind floating cards for downloads,
library storage, playback and the media services, with a strip of recent additions along the bottom. The header title
comes from `config.json` `title` and defaults to `HOMELAB`.

![MC4 Media](screenshots/mc4.jpg)

## Panels

- Header: `MEDIA // ACQUISITION`, a virtual private network (VPN) status line, a service health strip and a clock.
  - The service health strip counts apps OK, DEGRADED and DOWN across every app in `config.json` `groups`.
- Left column: a download client card, a library storage card and a media server card.
- Right column: a torrents list and a six-service status grid with one row shown degraded.
- Hero: a 3D acquisition flow.
  - Its brightness and spin follow the share of scored apps that are OK.
  - It draws in 2D on a software WebGL renderer. `?gl=3d` or `?gl=2d` forces either.
- Posters: a `RECENTLY ADDED` strip of 8 titles.

## Data

- `appScore`: the health score per app, for the service health strip and the hero's brightness.

The cards, the VPN line and the posters have no data source.

## States

- Stand-in:
  - Both card columns, the VPN line and the posters are always stand-in content.
  - The card columns and the VPN line carry `data-source="stand-in"`. Nothing on screen marks them.
- Service health: with no scored app, the strip counts sample scores, marked `data-source="stand-in"`, and records
  state `empty`.
- Pending, Idle, STALE, NO DATA and Unavailable: not used on MC4.
