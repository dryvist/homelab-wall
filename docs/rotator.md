# Rotator

The rotator is the page at `/`. It loads each slide in its own full-screen frame and cycles through them. Open it full
screen on a 1920×1080 display.

## Default order

With no `slides` list in `config.json`, the rotator shows these nine pages in this order:

1. `MC1`: `/mc1/`
2. `MC2`: `/mc2/`
3. `MC3`: `/mc3/`
4. `MC4`: `/mc4/`
5. `MC5`: `/mc5/`
6. `LEXICON`: `/mc6/`
7. `AI Benchmark Cockpit`: `/mc7/`
8. `SWITCHBOARD`: `/mc8/`
9. `Agent Constellation`: `/mc9/`

MC9 is last, after MC7 and MC8.

## Configuration

A deployment's `config.json` `slides` list overrides the default order. Each entry is
`{"name": "...", "url": "...", "seconds": N}`.

- `name` labels the slide's dot.
- `url` is the page to load. It may be a wall page or another origin.
- `seconds` is how long the slide shows. It defaults to 10.
- Only the first 10 slides load, to stay below the browser's limit on WebGL contexts.

Other keys the rotator reads:

- `holdSeconds`: how long a slide stays pinned after a user touches the wall. It defaults to 45 and is clamped to
  30 to 60.
- `reloadMinutes`: how often the whole wall reloads. It defaults to 60 and is clamped to 5 to 1440.

## Controls

- Moving the mouse shows the dots and pins the current slide for `holdSeconds`. A ring on the current dot shows the
  hold.
- A click moves to the next slide. A click on a dot jumps to that slide.
- The scroll wheel moves forward or back.
- The right and left arrow keys move forward and back.
- `P` pauses and resumes rotation.
- The dots hide again 3 seconds after the last input.

## Slide health

- A wall page signals that it is ready after its first painted frame.
- A slide on another origin counts as ready when its frame loads.
- A slide that is not ready within 5 seconds is skipped. The skip sets `data-skipped` on the dots for 4 seconds, with
  nothing shown on screen.
- A skipped slide is probed again every 5 minutes, and a late ready signal brings it back at once.
- Only the slide on screen renders. The rotator tells every other wall page to go idle, and those pages pause their
  render loops.
- The rotator forwards `?gl=3d` or `?gl=2d` to every same-origin `/mcN/` slide.

## Reloads

- The rotator reloads the whole wall every `reloadMinutes` once the origin is serving.
- Before it reloads, it fetches its own address and needs a 200 response, with no redirect, that loads the rotator
  script. Otherwise it keeps rotating and checks again every minute.
- A service worker (`/sw.js`) keeps the wall bootable while the origin is down. It serves the shell network-first and
  falls back to its cached copy on a network error or a 5xx response.
- The cached shell holds `/`, `/config.json`, `/mc6/`, and every same-origin file that `/` references. Slide frames
  load from the network as usual.
- A page opened on its own, such as `/mc1/`, refreshes its data every `refreshSeconds`. MC1 to MC7 also reload
  themselves every 24 hours.

## Test parameters

These query parameters exist for the test suite only:

- `?fast=<ms>` shortens every slide's time on screen.
- `?reprobe=<ms>` shortens the re-probe interval.
- `?reloadms=<ms>` shortens the reload interval.
