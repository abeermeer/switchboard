# API

## Gateway — `/v1`

OpenAI-compatible. Any client that talks to `api.openai.com` works unchanged apart from the
base URL.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Streaming and non-streaming |
| `POST` | `/v1/completions` | Legacy; rewritten into a chat request |
| `POST` | `/v1/embeddings` | |
| `POST` | `/v1/images/generations` | |
| `POST` | `/v1/audio/speech` | Returns audio bytes, not JSON |
| `POST` | `/v1/audio/transcriptions` | `multipart/form-data` |
| `POST` | `/v1/rerank` | |
| `POST` | `/v1/moderations` | |
| `GET` | `/v1/models` | |
| `GET` | `/v1/models/{model}` | |

Every endpoint answers `OPTIONS` with permissive CORS.

### Authentication

```
Authorization: Bearer sb-live-...
```

`x-api-key` is also accepted, for Anthropic-shaped clients.

**When no API key exists yet, the gateway runs open.** A fresh local install has to be
usable the moment it boots — requiring a key before the first request would mean you
cannot test anything until you have visited the dashboard. Create a key and enforcement
begins immediately.

### Validation

Deliberately shallow. Clients constantly send provider-specific extras
(`reasoning_effort`, `safety_settings`, cache hints) and rejecting an unknown field would
break a working integration for no benefit — the provider is the authority on its own
parameters. Only what routing reads is enforced: `model`, message presence, `stream`, and
the numeric ranges of `temperature`, `top_p` and `max_tokens`.

### Response headers

Present on every response, streaming or not:

| Header | Meaning |
| --- | --- |
| `x-switchboard-request-id` | Look this up in the request inspector |
| `x-switchboard-provider` | Which provider actually served it |
| `x-switchboard-model` | The provider-native model used |
| `x-switchboard-connection` | Which of your connections |
| `x-switchboard-tier` | `free` · `cheap` · `standard` · `premium` |
| `x-switchboard-strategy` | Strategy that made the decision |
| `x-switchboard-attempts` | Upstream calls made |
| `x-switchboard-cost-usd` | Cost of this request, 6 decimals |
| `x-switchboard-latency-ms` | Total routing + upstream time |
| `x-switchboard-ttft-ms` | Time to first token |
| `x-switchboard-fallback-reason` | **Only when a fallback happened** |

The absence of `x-switchboard-fallback-reason` means the first choice worked. Its presence
is the signal that something failed and was routed around.

### Errors

The OpenAI error envelope, byte for byte:

```json
{
  "error": {
    "message": "Access denied. Please check your network settings.",
    "type": "authentication_error",
    "param": null,
    "code": "auth"
  }
}
```

| Adapter error kind | HTTP |
| --- | --- |
| `auth` | 401 |
| `rate_limit`, `quota_exceeded` | 429 (with `Retry-After`) |
| `bad_request`, `context_length` | 400 |
| `unsupported` | 404 |
| `timeout` | 504 |
| everything else | 502 |

---

## Management — `/api`

Consumed by the dashboard. Guarded by `requireLocalOrToken`: loopback requests pass
freely; anything else needs the dashboard token and `SWITCHBOARD_ALLOW_REMOTE=1`.

### System

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/system/status` | Version, uptime, provider counts, today's spend |
| `POST` | `/api/system/bootstrap` | Idempotent first-run setup |

### Providers and connections

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/providers` | Full catalog, annotated with what you have connected |
| `GET` `POST` | `/api/connections` | List views · create |
| `GET` `PATCH` `DELETE` | `/api/connections/:id` | |
| `PUT` `DELETE` | `/api/connections/:id/credential` | Set · remove an API key |
| `POST` | `/api/connections/:id/test` | Force a probe, returns real latency |
| `GET` `POST` | `/api/connections/:id/models` | Catalog + discovered · refresh from provider |

No endpoint ever returns a stored credential. `PUT` responds with a four-character hint.

### Routing

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/api/combos` | |
| `GET` `PATCH` `DELETE` | `/api/combos/:id` | |
| `PUT` | `/api/combos/:id/members` | Replace the chain |
| `POST` | `/api/combos/:id/simulate` | **Score without sending anything upstream** |

`simulate` accepts `{ prompt?, inputTokens?, maxOutput?, requiredFeatures? }` and returns
the winner, the full ranked list with every score factor, and every exclusion with its
reason.

### Keys, health, logs

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/api/keys` | `POST` returns the plaintext secret exactly once |
| `PATCH` `DELETE` | `/api/keys/:id` | |
| `GET` | `/api/health` | Snapshots + active lockouts + overall state |
| `POST` | `/api/health/probe` | Probe one (`?id=`) or all |
| `POST` | `/api/health/:id/reset` | Reset a breaker |
| `GET` `DELETE` | `/api/logs` | Query · prune |
| `GET` | `/api/logs/:id` | Full detail with the decision trace |
| `POST` | `/api/logs/:id/replay` | Re-issue and compare against the original |

### Analytics and live

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/analytics/summary?days=` | Totals, per-provider, per-model, latency |
| `GET` | `/api/analytics/series?days=&bucket=` | Dense zero-filled series |
| `GET` | `/api/models` | Every model grouped by which providers serve it |
| `POST` | `/api/playground` | Race N models, NDJSON frames |
| `GET` | `/api/events` | SSE: `health`, `usage`, `log` every 2s |
| `GET` `PATCH` | `/api/settings` | |

`/api/events` is one stream for the entire dashboard. Every live widget subscribes through
a single client-side context rather than opening its own connection.
