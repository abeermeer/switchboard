# Providers

Sixteen providers ship in the catalog (`src/lib/providers/catalog.ts`). Nine have a real
free tier; seven are paid only. Pricing and quotas are what the providers published at the
time of writing — verify anything you are budgeting against.

## Free tiers

These need no payment method and can serve real work.

| Provider | Slug | Free tier | Models | Modalities |
| --- | --- | --- | --- | --- |
| Groq | `groq` | 14,400 req/day on small models | 9 | chat, transcription |
| Cerebras | `cerebras` | 1M tokens/day, 30 req/min | 6 | chat |
| Google Gemini | `google` | AI Studio: 250 req/day on Flash | 8 | chat, embeddings, images |
| Mistral AI | `mistral` | Experiment plan: 1B tokens/month | 10 | chat, embeddings |
| OpenRouter | `openrouter` | 50 req/day on `:free` models | 8 | chat |
| NVIDIA NIM | `nvidia-nim` | 1,000 credits, 40 req/min | 7 | chat, embeddings |
| SambaNova | `sambanova` | Free developer tier, ~10 req/min | 7 | chat, embeddings |
| Cohere | `cohere` | Trial keys: 1,000 calls/month | 7 | chat, embeddings, rerank |
| Ollama | `ollama` | Runs on your machine — no key, no quota | 8 | chat, embeddings |

Groq and Cerebras are the two worth connecting first: both are genuinely fast, both give a
daily allowance large enough for real coding work, and between them they cover most of the
open-weight models people actually use.

Ollama is special — it needs no credential at all (`requiresKey: false`) and points at
`http://localhost:11434/v1`. Connect it and every local model becomes a zero-cost fallback
for when your cloud quotas run dry.

## Paid providers

| Provider | Slug | Models | Modalities |
| --- | --- | --- | --- |
| OpenAI | `openai` | 11 | chat, embeddings, images, transcription |
| Anthropic | `anthropic` | 6 | chat |
| DeepSeek | `deepseek` | 3 | chat |
| Together AI | `together` | 9 | chat, embeddings, images |
| Fireworks AI | `fireworks` | 9 | chat, embeddings, images |
| Hyperbolic | `hyperbolic` | 8 | chat, images |
| xAI | `xai` | 7 | chat, images |

DeepSeek is worth calling out: it is paid, but priced low enough that it usually lands in
the `cheap` tier and gets picked immediately after the free tiers are exhausted.

## Wire protocols

| Adapter | Kind | Providers |
| --- | --- | --- |
| `openaiCompatible.ts` | `openai-compatible` | Groq, Cerebras, Together, OpenRouter, DeepSeek, Mistral, OpenAI, xAI, Fireworks, NVIDIA NIM, Hyperbolic, SambaNova, Ollama |
| `anthropic.ts` | `anthropic` | Anthropic |
| `google.ts` | `google` | Google |
| `cohere.ts` | `cohere` | Cohere |

Thirteen of sixteen providers speak the OpenAI wire format verbatim, which is why adding
one is usually a single catalog entry rather than new code.

## Cost tiers

Tiers drive the free-first ladder. They are inferred from the blended price
(`input × 0.75 + output × 0.25`), or set manually per connection:

| Tier | Blended $/MTok | Score weight |
| --- | --- | --- |
| `free` | 0, or covered by a free tier | 1.00 |
| `cheap` | ≤ 0.50 | 0.70 |
| `standard` | ≤ 5.00 | 0.40 |
| `premium` | > 5.00 | 0.15 |

### What counts as free

A request through a provider's published free allowance genuinely costs $0 until the quota
runs out, so Switchboard prices it that way — in routing, in the cost ceiling, and in the
spend figures on the dashboard. Charging list price for a request the user was never billed
for would both misrank the ladder and overstate their spend.

Free tiers are advertised against a provider's smaller models — Groq says "small models",
Google says "Flash" — never the flagship, and no provider publishes a machine-readable list
of which models qualify. Switchboard stands in for that with a price threshold: on a
provider with a free tier, models at or below **$1.00/MTok blended** are treated as free.

In practice that captures exactly the right set:

| Model | Provider | Treated as |
| --- | --- | --- |
| `llama-3.1-8b-instant` | Groq | free |
| `gemini-2.0-flash-lite` | Google | free |
| `qwen-3-235b-a22b-instruct` | Cerebras | free |
| `moonshotai/kimi-k2-instruct` | Groq | standard — $1.50, above the threshold |
| `gemini-2.5-pro` | Google | standard — $3.44, a flagship |
| `deepseek-chat` | DeepSeek | cheap — no free tier at all |

This is why a `free-only` policy still has 17 models to choose from rather than none.

## The same model, several providers

Open-weight models are the reason fallback works. `llama-3.3-70b` is served by Groq,
Cerebras, Together, Fireworks, Hyperbolic and SambaNova, at prices that differ by several
multiples for identical weights.

Send the bare model id and Switchboard spreads it across every connection that offers it.
The models page shows the price spread per model so you can see what you would be
overpaying.

## Model discovery

The catalog is a curated baseline with real pricing. Providers add models constantly, so
`POST /api/connections/:id/models` pulls the live list from the provider's own `/models`
endpoint and caches it in `discovered_models`.

Discovered models have no pricing attached — the provider does not publish it there — so
they are informational. A model needs a catalog entry to be cost-scored and routed.

## Adding one

If it speaks the OpenAI wire format, it is one entry in `catalog.ts`. See
[development.md](development.md).
