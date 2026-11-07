# MC9 · Agent Constellation

MC9 is the Agent Constellation, a beta page. Each AI agent signal is a node in a sky, sized by its measured 5-minute
rate and ringed by its last 24 hours. The default rotator lists MC9 last, after MC8, and names it
`Agent Constellation`.

![MC9 Agent Constellation](screenshots/mc9.jpg)

## Panels

- Header: `Mission Control 9 · Beta`, the title, a status line and a clock.
  - The status line counts signals reporting, pending and without a feed, and adds `STALE data` when any node is stale.
- Constellation: nine nodes, each with its label, rate, unit, and a last-seen or state line.
  - The gateway shows active agents; the cron node shows running jobs.
  - Request activity is measured in requests/s, memory activity in operations/s, and agent output in tokens/s.
  - The LLM spans node has no source and shows `No feed`.
- Footer: the legend (Active, Idle, Pending), how to read size and rings, and a `Pause motion` button.

Node rules:

- The two agent output nodes separate primary and subagent activity.
- One request node shows requests/s; one memory node shows operations/s.
- The gateway and cron nodes show the current totals from their respective queries.
- The LLM spans node has no signal.
- Node area grows monotonically with the 5m rate, approaching its ring; signals have different units and are
  labelled.
- Rings show measured 5m rates over 24h (brightness relative to each node's own maximum), with timestamp gaps
  unfilled.
- Rings start at the top, oldest first, and run clockwise.
- Last seen is the end of the last positive activity window, with 5-minute resolution for historical samples; it is
  unknown when no activity was observed.
- Lines show agent grouping only.
- No host, session, or user identities appear.
- Pause and reduced motion stop glow animation.

## Data

MC9 reads role-specific queries from the metrics gateway or snapshot.

- Request activity, memory activity and agent output rates use trailing 5-minute windows.
- `mc9GatewayAgents`: current active-agent total.
- `mc9CronJobs`: current running-job total.
- The LLM spans node has no query.

Each key is read as a current value and as a 24-hour range at 5-minute steps.

- History refreshes every 5 minutes; current rates follow `refreshSeconds`.
- Requests time out after 10 seconds.

## States

- MC9 shows measured readings or a visible missing-data state; it does not fill missing readings with invented values.
- Pending:
  - Missing signals stay visible as pending.
  - An empty 24h ring is pending.
- No feed: the LLM spans node shows `No feed` and the status line counts it.
- STALE:
  - A signal that disappears or fails retains its last measured value as STALE.
  - Current readings become stale after 300 seconds even during an unfinished poll.
  - History becomes stale when its refresh fails or its last successful refresh is over 10 minutes old.
  - Stale history marks the page header only where its ring is drawn.
  - A series that has gone quiet keeps current history.
- Idle:
  - Zero means a measured idle rate.
  - A subagent series exists only while a subagent works, so a satellite without its own row reads zero, at its
    parent's sample time, while the parent reports.
- NO DATA and Unavailable: not used on MC9.
