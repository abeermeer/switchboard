# AGENTS.md

Instructions for coding agents working in this repository. Tool-agnostic; Claude Code reads
[CLAUDE.md](CLAUDE.md), which carries the same rules with more context.

## Project

**Switchboard** — a local-first AI gateway. One OpenAI-compatible endpoint in front of 16
LLM providers, free-tier-first routing, automatic fallback, and a persisted decision trace
for every request.

Stack: Next.js 16 (App Router) · React 19 · TypeScript 5.9 strict · Tailwind v4 (CSS-first,
no config file) · `node:sqlite` · Electron 43.

## Setup

```bash
npm install
npm run dev
```

Requires Node **22.13+**. `node:sqlite` was flag-gated until 22.13.

## Validation

Run both before proposing any change. CI enforces them on Node 22.13 and 24, on Ubuntu and
Windows.

```bash
npm run typecheck   # tsc --noEmit, strict
npm run build
```

There is no test suite yet. Do not claim a change is "tested" — say what you verified and
how.

## Layout

```
src/types/core.ts        the domain contract — imports nothing, everything imports it
src/lib/db/              node:sqlite client, append-only migrations, repositories
src/lib/crypto/          AES-256-GCM credential vault
src/lib/auth/            session, rate limit, budget
src/lib/providers/       catalog (16 providers) + 4 wire adapters + registry
src/lib/resilience/      circuit breaker
src/lib/router/          candidates → score → execute
src/lib/usage/cost.ts    cost, savings, free-tier settlement
src/app/v1/              OpenAI-compatible gateway
src/app/api/             management API (dashboard)
src/components/ui/       design system primitives
bin/                     the `sb` / `switchboard` CLI
electron/                desktop shell
```

## Non-negotiable constraints

Each of these fails silently or at build time rather than at typecheck:

| Rule | Why |
|---|---|
| Type-only imports use `import type` | `verbatimModuleSyntax` is on |
| `arr[0]` is `T \| undefined` | `noUncheckedIndexedAccess` is on |
| No `any` — use `unknown` and narrow | strict mode |
| Server modules never imported by `'use client'` | `node:sqlite`/`node:crypto`/`node:fs` break the client bundle |
| DB route handlers set `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` | otherwise Next tries to prerender them |
| Route params are `Promise<{...}>` and must be awaited | Next 16 |
| Migrations are append-only | `user_version` drives replay; editing one corrupts existing installs |
| Bind only `null\|number\|string\|bigint\|Uint8Array` to SQLite | booleans via `toInt()`, never `undefined` |
| No `document`/`window` access during render | SSR has neither; this 500s every page |
| No hex colours, no `bg-gray-*`, no `dark:` variants | the token layer in `globals.css` handles both themes |
| Tailwind class names must be static strings | `text-${tone}` is never extracted into the CSS |

## Deliberate behaviour — do not "fix"

- Gateway runs unauthenticated until the first API key is created.
- `bad_request` (400) does not trigger a fallback.
- A stream that has emitted a byte is never retried.
- Free-tier models settle at $0 (`settleRequest` in `src/lib/usage/cost.ts`).
- An empty combo member chain means "every eligible connection".
- The CLI pins `SWITCHBOARD_DATA_DIR` so a global install never stores data in
  `node_modules`.

Each has a comment at the site explaining why. Read it before changing it.

## Adding a provider

One entry in `src/lib/providers/catalog.ts` if it speaks the OpenAI wire format — 13 of 16
do. Pricing must come from the provider's published pricing page; it drives tier inference,
cost scoring, budget ceilings, and analytics.

## Commit style

Present tense, imperative subject. Explain the *why* in the body when it is not obvious from
the diff:

```
Correct the minimum Node version to 22.13

node:sqlite shipped in 22.5 but stayed behind --experimental-sqlite until
22.13, so every stated requirement of "22.5+" was wrong.
```

## Security

- Never commit `master.key`, `switchboard.db`, or anything under `data/`.
- Never add a credential to the `files` array in `package.json`; run
  `npm run pack:check` and confirm the tarball is clean.
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
