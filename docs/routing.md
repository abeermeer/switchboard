# Routing

## Policies

A policy — `combo` in the API — is a model name your clients can send. Four ship by default
and are created on first run.

| Slug | Strategy | Purpose |
| --- | --- | --- |
| `auto` | `free-first` | The default. Free tiers first, then paid. |
| `free-only` | `free-first`, `maxCostPerMTok: 0` | Free tiers only; fails rather than spend. |
| `fast` | `fastest` | Lowest measured time to first token. |
| `quality` | `quality-first` | Strongest model available, cost ignored. |

A policy with an **empty member chain** considers every eligible connection. That is the
default and usually the right answer — pin members only when you want a specific order.

## What clients can send as `model`

| Value | Behaviour |
| --- | --- |
| `auto` | The default policy |
| A policy slug (`free-only`) | That policy |
| A bare model id (`llama-3.3-70b-versatile`) | Every connection offering it |
| `provider/model` (`groq/llama-3.3-70b`) | Pinned provider, still spread across its connections |
| Anything unrecognised | Falls through to the default policy |

## Strategies

| Strategy | Dominant weights | Trades away |
| --- | --- | --- |
| `free-first` | tier 0.34, cost 0.22 | Some latency |
| `cost-optimized` | cost 0.44 | Latency and quality |
| `fastest` | latency 0.40, throughput 0.18 | Cost |
| `quality-first` | cost 0.34 *inverted*, health 0.24 | Money |
| `priority` | priority 0.62 | Live health signals |
| `round-robin` | health 0.50, rotating head | Optimality per request |
| `failover` | priority 0.66 | Everything but predictability |

`quality-first` inverts the cost factor: a higher price becomes evidence of a stronger
model. It is a heuristic, not a benchmark, but it tracks reality closely enough.

## Scoring

Eight factors, each producing a 0–1 value multiplied by its strategy weight:

| Factor | Measures |
| --- | --- |
| `health` | Rolling success rate; halved while the breaker is half-open |
| `latency` | p50 TTFT, normalized against the fastest current candidate |
| `cost` | Projected USD, normalized against the cheapest current candidate |
| `tier` | free 1.0 · cheap 0.7 · standard 0.4 · premium 0.15 |
| `priority` | Chain position, or the connection's priority number |
| `quota` | Budget headroom remaining |
| `throughput` | Published tokens/sec prior |
| `stability` | Consecutive failures since the last success |

Relative factors are normalized against the current candidate set, not an absolute scale.
"Cheapest available right now" is the only comparison that means anything at routing time.

The `cost` factor and the policy's cost ceiling both use the **effective** price — $0 for a
model covered by a provider's free allowance, list price otherwise. A `maxCostPerMTok` of 0
therefore means "free tiers only" rather than "nothing at all". See
[providers.md](providers.md#what-counts-as-free).

Unmeasured candidates score `0.5` on latency — optimistic enough to earn a first request,
not so optimistic that they displace a proven fast provider.

`priority` and `failover` ignore the blended score for ordering and sort strictly by chain
position, but the score and its factors are still computed so the trace stays explanatory.

## Exclusions

A candidate removed before scoring records why. These are the reasons:

- Connection is disabled
- No API key configured
- Circuit breaker open
- Model rate-limited (429 lockout active)
- Model does not serve this modality
- Model lacks a required feature
- Context window too small for this prompt
- Over the policy's cost ceiling
- Connection's monthly budget exhausted
- API key over budget and restricted to free providers

All of them surface verbatim in the dashboard and in the stored decision trace.

## Fallback

The router walks the ranked list up to `maxAttempts`. Whether a failure triggers a fallback
depends on its classified kind:

| Error kind | Falls back? | Why |
| --- | --- | --- |
| `rate_limit` (429) | yes | Another provider has quota |
| `quota_exceeded` | yes | Same |
| `auth` (401/403) | yes | A different connection may hold a valid key |
| `server` (5xx) | yes | Provider-side fault |
| `timeout` | yes | Provider-side slowness |
| `network` | yes | Transport fault |
| `unsupported` (404) | yes | Another provider may serve this model |
| `context_length` | only if a larger candidate exists | Otherwise identical failure |
| `bad_request` (400) | **no** | The caller's fault — same 400 everywhere |

`bad_request` stopping the walk is deliberate. Retrying a malformed body across five
providers produces five identical 400s and makes the client wait five times as long for
the same answer.

### Streaming

A streaming response that has already emitted its first byte is **never** retried. Once
bytes are on the wire the client has committed to that response; switching providers
mid-stream would splice two different completions together.

## Budgets

Two independent ceilings:

- **Per connection** (`monthlyBudgetUsd`) — excludes that connection once month-to-date
  spend reaches it.
- **Per API key** (`monthlyBudgetUsd`) — either blocks with a 429, or silently restricts
  routing to free providers, depending on `onBudgetExceeded`.

`downgrade-to-free` is the default because a key hitting its cap at 2am should degrade,
not break the thing that depends on it.

## Simulating

`POST /api/combos/:id/simulate` runs the exact expand-and-score path a live request takes
and returns the full ranking, every score factor, and every exclusion — without sending
anything upstream. The routing page re-runs it on every config change.
