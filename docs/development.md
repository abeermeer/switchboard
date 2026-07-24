# Development

## Setup

```bash
npm install
npm run dev          # :7272, Turbopack
npm run typecheck    # tsc --noEmit
npm run build
```

Node **22.13+** is required. `node:sqlite` shipped in 22.5 but was gated behind
`--experimental-sqlite` until 22.13, so older releases throw `ERR_UNKNOWN_BUILTIN_MODULE`
at build time. Node 24 is what this was built and tested on.

## Repo layout

```
src/
  types/core.ts            the domain contract — everything imports from here
  lib/
    db/                    node:sqlite client, schema, repositories
    crypto/vault.ts        AES-256-GCM sealing
    auth/                  session, rate limit, budget
    providers/             catalog + 4 wire adapters + registry
    resilience/breaker.ts  circuit breaker
    health/probe.ts        probe + background scheduler
    router/                candidates → score → execute
    usage/cost.ts          cost and savings arithmetic
    api/                   shared request pipeline
  app/
    v1/                    OpenAI-compatible gateway
    api/                   management API
    (dashboard)/           dashboard pages
  components/
    ui/                    design system primitives
    shell/                 sidebar, topbar, palette, SSE context
bin/                       the `sb` CLI
electron/                  desktop shell
```

## Conventions

- **`src/types/core.ts` is the contract.** It imports nothing. Everything else imports
  from it.
- **`verbatimModuleSyntax` is on** — type-only imports must be `import type`.
- **`noUncheckedIndexedAccess` is on** — `arr[0]` is `T | undefined`. Use `!` only where
  the index is provably in range.
- **No `any`.** Use `unknown` and narrow.
- Server-only modules (anything touching `node:sqlite`, `node:crypto`, `node:fs`) must
  never be imported by a `'use client'` component.
- Route handlers touching the DB need `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`.
- Next 16 route params are async: `{ params }: { params: Promise<{ id: string }> }`.
- Comments explain **why**, not what.

## The database

Migrations in `src/lib/db/schema.ts` are **append-only**. Never edit a shipped migration —
add a new one with the next version number. `runMigrations` applies anything newer than
`PRAGMA user_version` inside a transaction.

Repositories in `src/lib/db/repos/` are the only code that writes SQL. Each maps rows to
domain types explicitly.

`node:sqlite` binds only `null | number | string | bigint | Uint8Array`. Booleans must go
through `toInt()`; `undefined` must become `null`.

## Adding a provider

If it speaks the OpenAI wire format, this is the whole change — one entry in
`src/lib/providers/catalog.ts`:

```ts
{
  id: 'newprovider',
  name: 'New Provider',
  kind: 'openai-compatible',
  baseUrl: 'https://api.newprovider.com/v1',
  authScheme: 'bearer',
  modelsPath: '/models',
  docsUrl: 'https://docs.newprovider.com',
  signupUrl: 'https://newprovider.com/signup',
  freeTier: {
    summary: '1M tokens/day, no card',
    requestsPerDay: null,
    tokensPerMinute: null,
    noCardRequired: true,
  },
  modalities: ['chat'],
  accent: '#3B82F6',
  requiresKey: true,
  blurb: 'One line describing what makes it worth connecting.',
  models: [
    {
      id: 'their-model-name',
      name: 'Their Model',
      modality: 'chat',
      features: ['tools', 'streaming'],
      contextWindow: 131072,
      maxOutput: 8192,
      inputCostPerMTok: 0.20,
      outputCostPerMTok: 0.60,
      throughputPrior: 250,
    },
  ],
}
```

That is it. The registry picks it up, the dashboard renders it, the router scores it, and
the tier is inferred from the prices.

**Pricing must be real.** It drives the cost factor, the tier, the budget ceilings and
every number in analytics. A guessed price silently corrupts all of them.

If the provider does *not* speak OpenAI:

1. Add a `ProviderKind` in `src/types/core.ts`.
2. Write an adapter in `src/lib/providers/adapters/` implementing `ProviderAdapter`.
   Translate both directions, including the SSE stream.
3. Register it in `src/lib/providers/adapters/index.ts`.
4. Reuse `shared.ts` for fetch-with-timeout, `Retry-After` parsing, SSE framing and usage
   normalization.

## Adding a routing strategy

1. Add it to the `RoutingStrategy` union in `src/types/core.ts`.
2. Add a full weight row to `STRATEGY_WEIGHTS` in `src/lib/router/score.ts` — the record
   is total, so TypeScript will tell you if you missed a factor.
3. If it needs non-score ordering (like `priority` does), handle it in the sort at the
   bottom of `scoreCandidates`.
4. Add it to the zod enums in `src/app/api/combos/route.ts` and `[id]/route.ts`.
5. Add a card to `STRATEGIES` in `src/components/routing/PolicyEditor.tsx` explaining in
   one sentence what it optimises for and what it gives up.

## Adding a score factor

1. Extend the `FactorName` union in `score.ts`.
2. Add a weight to **every** strategy row — the compiler enforces this.
3. Push a `ScoreFactor` inside `scoreCandidates` with a `note` written the way an engineer
   would explain the choice out loud. The dashboard renders those notes verbatim.

## Verifying a change end to end

```bash
npm run typecheck
npm run build
npm start &

curl -s localhost:7272/api/system/status
curl -s -X POST localhost:7272/api/system/bootstrap
curl -s -X POST localhost:7272/api/connections \
  -H 'content-type: application/json' \
  -d '{"providerId":"groq","apiKey":"gsk_..."}'

# Then simulate to see the ranking without spending anything:
curl -s -X POST "localhost:7272/api/combos/<id>/simulate" \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello"}'
```

`node bin/sb.mjs doctor` checks the Node version, `node:sqlite` availability, data
directory permissions, the build, every connection's credential and health, and whether
any API keys exist.
