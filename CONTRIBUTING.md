# Contributing

Thanks for taking an interest. This document covers what you need to be productive quickly.

## Setup

```bash
npm install
npm run dev          # http://localhost:7272
```

Node **22.13 or newer** is required. Switchboard uses the built-in `node:sqlite`, which
appeared in 22.5 but stayed behind `--experimental-sqlite` until 22.13 — on anything older
the build fails with `ERR_UNKNOWN_BUILTIN_MODULE`. Node 24 is what it is developed against.

## Before you open a PR

```bash
npm run typecheck    # must be clean
npm run test:run     # must be green
npm run build        # must succeed
```

All three are enforced in CI on Node 22.13 and 24, on Ubuntu and Windows. `typecheck` runs
`tsc --noEmit` against strict mode with `noUncheckedIndexedAccess`, so a PR that compiles
locally will compile in CI.

## Tests

Vitest, in `tests/`. Read `tests/unit/vault.test.ts` first — it sets the expected style.

- Any suite that writes rows uses `freshDb()` / `dropDb()` from `tests/helpers/db.ts`.
  Tests must not depend on execution order.
- Stub the network with `stubUpstream()` from `tests/helpers/upstream.ts`. It replaces
  global `fetch`, which is the boundary every adapter goes through, so the real adapter and
  router still run. **No test may reach a real provider.**
- Test what the comments claim. If a comment says a behaviour is deliberate, there should
  be a test that fails when someone removes it.

A change to routing, cost, resilience or the adapters needs a test. A change to the
dashboard does not yet — there is no component harness — so say what you verified by hand.

## The shape of the codebase

`src/types/core.ts` is the contract. It imports nothing; everything else imports from it.
If a shared shape needs to change, it changes there first and the compiler tells you what
else moved.

```
src/lib/db/          persistence — the only place SQL is written
src/lib/providers/   catalog + wire adapters
src/lib/router/      candidates → score → execute
src/lib/api/         shared request pipeline
src/app/v1/          OpenAI-compatible gateway
src/app/api/         management API
src/components/ui/   design system primitives
```

Read [docs/architecture.md](docs/architecture.md) before changing anything in `src/lib/`.

## Conventions

- **No `any`.** Use `unknown` and narrow.
- **Type-only imports must be `import type`** — `verbatimModuleSyntax` is on.
- **`arr[0]` is `T | undefined`** — `noUncheckedIndexedAccess` is on. Use `!` only where the
  index is provably in range.
- **Never import a server module from a `'use client'` component.** Anything touching
  `node:sqlite`, `node:crypto` or `node:fs` is server-only.
- **Route handlers that touch the database** need `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`.
- **Comments explain why, not what.** If a line needs a comment saying what it does, rename
  something instead.

### Styling

The dashboard is built on a token layer in `src/app/globals.css`. Use the semantic
utilities — `bg-surface`, `text-muted`, `border-line`, `text-accent` — and never a raw
colour. No hex codes, no `bg-gray-*`, no `dark:` variants. Both themes then work for free,
and a PR that hardcodes a colour will look broken in one of them.

## Adding a provider

If the provider speaks the OpenAI wire format, this is a single entry in
`src/lib/providers/catalog.ts` and no other change. See
[docs/development.md](docs/development.md#adding-a-provider) for the template.

**Pricing must be real.** It drives the cost factor, the tier ladder, the budget ceilings
and every figure in analytics. A guessed price silently corrupts all of them. Link the
provider's pricing page in your PR description.

If the provider does not speak OpenAI, you will also need an adapter — see
[docs/development.md](docs/development.md).

## Adding a routing strategy

1. Extend the `RoutingStrategy` union in `src/types/core.ts`.
2. Add a full weight row to `STRATEGY_WEIGHTS` in `src/lib/router/score.ts`. The record is
   total, so the compiler will tell you if you missed a factor.
3. Add it to the zod enums in `src/app/api/combos/`.
4. Add a card to `STRATEGIES` in `src/components/routing/PolicyEditor.tsx` explaining in one
   sentence what it optimises for **and what it gives up**.

## Reporting a bug

Include the output of:

```bash
node bin/sb.mjs doctor
```

It reports the Node version, `node:sqlite` availability, data directory permissions, and
every connection's credential and health state — which is most of what is needed to
reproduce a routing problem.

**Never paste an API key, a `sb-live-` token, or the contents of `master.key` into an
issue.** Redact them.

## Commit messages

Present tense, imperative, explain the why in the body if it is not obvious:

```
Treat free-tier models as $0 in the cost ceiling

A provider's published free allowance means those requests genuinely cost
nothing, so pricing them at list rate made the free-only policy match no
models at all and overstated spend on the dashboard.
```

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
