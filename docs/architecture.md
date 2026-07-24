# Architecture

How a request moves through Switchboard, module by module.

## The path of one request

```
POST /v1/chat/completions
  │
  ├─ src/app/v1/chat/completions/route.ts
  │    derives required features from the body (tools → 'tools', an image part
  │    → 'vision') and hands off to the shared pipeline
  │
  ├─ src/lib/api/handler.ts · handleModality()
  │    parse → validate (zod) → authenticate → route() → respond → log
  │
  ├─ src/lib/api/respond.ts · authenticate()
  │    bearer token → key lookup → rate limit → budget check
  │
  ├─ src/lib/router/index.ts · route()
  │    │
  │    ├─ src/lib/usage/cost.ts · estimateInputTokens()
  │    ├─ src/lib/router/candidates.ts · expandCandidates()
  │    ├─ src/lib/router/score.ts · scoreCandidates()
  │    └─ src/lib/router/execute.ts · executeRoute()
  │         └─ src/lib/providers/adapters/* · adapter.execute()
  │
  └─ src/lib/db/repos/log.ts + usage.ts
       one log row, one decision trace, one hourly usage bucket
```

## Layers

### Domain contract — `src/types/core.ts`

Every shared shape lives here and nothing else imports upward into it. Adapters,
repositories, the router and the dashboard all speak these types, which is what keeps
the wire format of eleven different providers from leaking into the UI.

### Persistence — `src/lib/db/`

`client.ts` opens Node's built-in `node:sqlite` with WAL journaling, so the dashboard can
read while the gateway writes. Migrations in `schema.ts` are append-only and applied by
`user_version`; a shipped migration is never edited.

Repositories in `repos/` are the only code that writes SQL. Each one maps rows to domain
types explicitly rather than spreading raw snake_case rows into objects.

Tables:

| Table | Holds |
| --- | --- |
| `connections` | A configured provider instance |
| `credentials` | AES-256-GCM sealed API keys |
| `combos`, `combo_members` | Routing policies and their chains |
| `api_keys` | Client keys, hashed |
| `health`, `latency_samples`, `model_lockouts` | Live resilience state |
| `request_log`, `request_payloads` | Per-request history and decision traces |
| `usage_buckets` | Hourly rollups so charts never scan the log |
| `discovered_models` | Models pulled live from a provider |
| `settings` | Key/value configuration |

### Providers — `src/lib/providers/`

`catalog.ts` is a curated list of 16 providers with real pricing, context windows and
free-tier facts. `registry.ts` resolves a provider to its adapter and infers its cost tier.

Four adapters cover every provider:

| Adapter | Providers |
| --- | --- |
| `openaiCompatible.ts` | Groq, Cerebras, Together, OpenRouter, DeepSeek, Mistral, OpenAI, xAI, Fireworks, NVIDIA NIM, Hyperbolic, SambaNova, Ollama |
| `anthropic.ts` | Anthropic — translates to and from `/v1/messages` |
| `google.ts` | Google — translates to and from `generateContent` |
| `cohere.ts` | Cohere v2 |

Every adapter returns the same `AdapterResponse`: OpenAI-shaped JSON or an OpenAI-shaped
SSE stream, normalized usage, measured TTFT, and a classified `AdapterError`.

### Resilience — `src/lib/resilience/`, `src/lib/health/`

The breaker classifies failures rather than counting them uniformly:

| Error kind | Effect |
| --- | --- |
| `auth` | Opens the breaker immediately — a bad key will not fix itself |
| `rate_limit` | Locks out that model only, honouring `Retry-After` |
| `quota_exceeded` | Locks out the model for 15 minutes |
| `bad_request` | Not counted at all — the caller's fault, not the provider's |
| everything else | Counts toward the consecutive-failure threshold |

Cooldown is `base × 2^(opens−1)`, capped at 15 minutes, with ±20% jitter so a fleet of
clients does not stampede a recovering provider simultaneously.

### Router — `src/lib/router/`

**`candidates.ts`** turns the client's `model` string into every connection+model pair that
could serve it:

| Input | Resolution |
| --- | --- |
| A policy slug | That policy's members, or all connections when the chain is empty |
| `auto` / unknown | The default policy |
| `provider/model` | Pinned to that provider, still spread across its connections |
| A bare model id | Every connection offering it — this is the fallback story |

Filtering records an `excludedReason` rather than dropping silently, because the decision
trace is only useful if it can show what lost and why.

**`score.ts`** weights eight factors per strategy. Relative factors (cost, latency) are
normalized against the current candidate set — "cheapest available" is the only meaningful
comparison at routing time. Each factor carries a human-readable `note` that the dashboard
renders verbatim.

The weight table is exported as `STRATEGY_WEIGHTS` so the UI can show what a strategy
actually optimises for instead of asking the user to trust a label.

**`execute.ts`** walks the ranked list. It stops early when retrying elsewhere cannot help,
and never retries a stream that has already emitted a byte.

### API surface

`src/app/v1/` is the OpenAI-compatible gateway. `src/app/api/` is the management API the
dashboard consumes — every handler is guarded by `requireLocalOrToken`, validates with zod,
and returns a clean error rather than a stack trace.

`/api/events` is a single Server-Sent Events stream feeding the whole dashboard. Every live
widget subscribes through one client-side context; eight panels would otherwise hold eight
sockets and run eight copies of the poll loop.

## Cost model

Actual cost, in `src/lib/usage/cost.ts`:

```
(prompt − cached) × inputRate
  + cached × inputRate × 0.10
  + (completion + reasoning) × outputRate
```

all per 1M tokens. Cached tokens are already inside `promptTokens` for every provider that
reports them, so they are subtracted before billing at full rate.

`settleRequest(providerId, modelId, usage)` is what the gateway actually calls. It resolves
the provider first, and returns **$0** when the model is covered by that provider's free
allowance — see [providers.md](providers.md#what-counts-as-free). Every consumer of cost
goes through it: the request log, the usage rollups, the `x-switchboard-cost-usd` header
and the playground. A free-tier request that reported its list price would overstate the
dashboard's headline spend with money the user never paid.

Savings are measured against a frontier baseline of **$3.00/MTok in, $15.00/MTok out** —
what the same traffic would have cost on a premium model. Never negative: `quality-first`
deliberately routes above the baseline, and that is a real choice rather than a loss.
