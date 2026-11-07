# MC5 · GitOps

MC5 is a GitOps pipeline overview for a public organization. A 3D organization core with orbiting repository nodes
fills the screen, and comets fly through push, pull request, merge, release and deploy. Four cards float over it. The
header title comes from `config.json` `title` and defaults to `HOMELAB`.

![MC5 GitOps](screenshots/mc5.jpg)

## Panels

- Header: `PIPELINE // GITOPS`, the organization name and a clock.
- Hero: the organization core, a ring of up to 14 repositories, and comets.
  - The repositories are the organization's public ones, most recently pushed first.
  - Each new organization event sends a comet. Push, pull request, merge, release and deploy events fly to their own
    stage.
  - It draws in 2D on a software WebGL renderer. `?gl=3d` or `?gl=2d` forces either.
- Org activity: a ticker of the organization's 14 newest events, each with actor, repository, action and age.
- Service health: an app grid in `config.json` group order, with one empty cell between groups.
  - The title counts apps OK, DEGRADED and DOWN.
- Latest releases: the latest release tag and age for each of the 5 most recently pushed repositories.
- Terrakube and Semaphore: the rows have no feed and show `No feed`.

## Data

- `appScore`: the health score per app, for the service health grid.

MC5 calls the public organization API from the browser for events, repositories and releases.

- Events: polled at the interval the API asks for, never more often than once a minute.
- Repositories: public repositories sorted by last push, polled hourly.
- Releases: the latest release of each of the top 5 repositories, read after each repository poll.
- Every call sends a conditional request with the last ETag, and every response is cached in `localStorage`.

## States

- No feed:
  - The Terrakube and Semaphore rows have no feed and show `No feed`.
  - Without cached organization data, the hero and ticker do not add repository or event rows.
  - With no release rows, the panel reads `NO RELEASE DATA`.
- Service health: missing scores show `—`. With no scores, the panel records state `empty` and reads
  `NO SERVICE DATA` or `NO APPS CONFIGURED`.
- Service health after a failed score query:
  - With no held scores, the panel records state `error` and reads `SCORE QUERY FAILED`.
  - With held scores, it keeps them and records state `stale`.
- Failed organization queries show an error or retain the last real data with state `stale`.
- Pending: used before the first data poll. Idle, NO DATA and Unavailable: not used on MC5.
