# MC8 · Router Switchboard

MC8 is the Router Switchboard, a beta page. It draws token flow from each caller, through the LiteLLM router, to each
model, grouped by billing class, with four router readouts above it. MC8 uses real measurements only. The rotator
names this slide `SWITCHBOARD`.

![MC8 Router Switchboard](screenshots/mc8.png)

## Panels

- Readouts:
  - Local token share: the local engines' share of classified input and output tokens, with the unclassified
    percentage shown separately.
  - Router in-flight: requests in flight across the router.
  - Pay per token / month: OpenRouter spend in cents since the month boundary in Coordinated Universal Time (UTC).
  - Time to first token / p95: the router's time to first token (TTFT) p95 (95th percentile) over the trailing
    5 minutes, in milliseconds.
- Switchboard: callers on the left, the LiteLLM hub in the middle, and models by provider on the right.
  - Routes retain caller alias and team, model, and provider labels.
  - Width means input plus output tokens/s over 5 minutes.
  - Focus or hover a caller or model to trace its paths.
  - The hub reads the total tokens/s, or `Idle` at zero.
- Billing banks: models sit in banks for local engines, subscriptions, pay per token, free, and unclassified.
  - Billing banks use the token series' `tag_telemetry_billing_class_` labels: `local`, `subscription`, `paid`, and
    `free`, when their string value is `true`.
  - Series with all flags false or missing remain Unclassified; provider names never determine billing.
  - Rates retain these labels through aggregation.
- Failure flashes:
  - Failure flashes apply to model edges with measured failure or failed-fallback increases over the last minute.
  - Those counters do not establish caller attribution.
  - Model failure markers also appear at zero token throughput; failure-only models show `No token rate` rather
    than a made-up zero.
  - Failure and failed-fallback indicators cover the one-minute window that ends at each result's evaluation time,
    and expire 75 seconds after it.
  - Past 25 seconds the marker names how long ago that window ended.
- Footer and legend: the flow and failure status lines, and the colour of each bank and flash.

## Data

- `mc8InputRate`: input tok/s over 5 minutes, by caller alias, team, model, provider and billing class.
- `mc8OutputRate`: output tok/s over 5 minutes, grouped the same way.
- `mc8InputSourceTime`: the last sample time of each raw input token counter, grouped the same way.
- `mc8OutputSourceTime`: the last sample time of each raw output token counter, grouped the same way.
- `mc8InFlight`: requests in flight across the router.
- `mc8InFlightSourceTime`: the last sample time of the in-flight series. MC8 uses it as router liveness.
- `mc8TtftP95`: router TTFT p95 over 5 minutes.
- `mc8TtftSourceTime`: the last sample time of the TTFT histogram.
- `mc8Failures`: failure responses per model and provider over the last minute.
- `mc8FailuresSourceTime`: the last sample time of the failure counters.
- `mc8Fallbacks`: failed fallbacks per model and provider over the last minute.
- `mc8FallbacksSourceTime`: the last sample time of the failed-fallback counters.
- `mc8SpendCents`: OpenRouter spend in cents since the UTC month boundary.
- `mc8SpendSourceTime`: the newest sample time of any router spend series.

TTFT p95 uses standard router histogram buckets. It comes from bucket increases, which also count a new series' first
small bucket counts.

Spend shows OpenRouter cents since the UTC month boundary: each series' rise over its month-start baseline, clamped at
zero, then summed. Counter resets can still undercount month-to-date spend, and the page says so.

Token-rate freshness uses the raw input and output counter sample times, grouped by caller, team, model, provider and
billing class. In-flight, TTFT, failure and fallback freshness use their raw series' sample times. Spend freshness
uses the newest sample of any router spend series, since a provider's spend series exists only after use.

The page polls every `config.json` `refreshSeconds`, 15 seconds by default and at least 1 second. Each request
times out after 10 seconds.

## States

- Pending: failed queries, and empty ones not covered below, show `Pending` until the first reading.
- STALE:
  - Later gaps retain the last measurement with a visible `STALE` age.
  - Measurements older than 5 minutes, more than 5 seconds ahead, or without a valid timestamp are stale, even after
    a successful snapshot refresh.
  - The unclassified percentage has its own stale state from the same token-rate sample times.
  - Stale failure readings never trigger flashes.
- Idle:
  - An empty TTFT result reads `Idle` while the histogram's sample time is fresh.
  - Zero token rate means idle.
- Zero: an empty failure, fallback or spend result reads as zero while the router is live, meaning the in-flight
  sample time is fresh.
- Unavailable:
  - Local share uses classified token rates only.
  - Without classified traffic it shows `Unavailable`.
- NO DATA: not used on MC8.
