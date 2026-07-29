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

Run all three before proposing any change. CI enforces them on Node 22.13 and 24, on
Ubuntu and Windows.

```bash
npm run typecheck   # tsc --noEmit, strict
npm run test:run    # vitest, ~1,030 tests
npm run build
```

If you touch anything under `electron/`, add `npm run verify:electron` — it checks the
builder config, the icons (magic bytes *and* dimensions), that both scripts parse, and that
the renderer hardening flags are still on. CI runs it on every leg; the real
`electron-builder` run lives in `.github/workflows/desktop.yml`.

### Writing tests

Tests live in `tests/`. Read `tests/unit/vault.test.ts` first — it is the reference for
style and depth.

- Suites that write rows call `freshDb()` in `beforeEach` and `dropDb(dir)` in `afterEach`
  (`tests/helpers/db.ts`). No test may depend on execution order.
- Stub the network with `stubUpstream()` from `tests/helpers/upstream.ts`, which replaces
  global `fetch` — the boundary every adapter goes through. **Never let a request reach a
  real provider.**
- `tests/setup.ts` redirects the data directory before any import. Do not import
  application modules above it.
- Component tests live in `tests/components/` and opt into a DOM with a
  `@vitest-environment jsdom` docblock. Test through the accessible surface — role, name,
  `aria-*` — so a test fails when a component becomes unusable, not when a class changes.
- **Never import a server module from a jsdom test.** Pulling `node:sqlite` into a
  browser-target bundle fails on Node 22.13 but passes on 24, so it goes green locally and
  red in CI.
- Test the behaviour the code comments describe. Anything marked deliberate should have a
  test that fails if it is "simplified" away.

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
- `/v1` sends no `Access-Control-Allow-Origin` unless `SWITCHBOARD_CORS_ORIGINS` is set.
- Response header values are sanitised to ASCII — they are ByteStrings, and a non-ASCII
  provider error would otherwise throw inside `new Response`.
- `recomputeLatency` counts successes only; a fast failure would otherwise make a broken
  provider look like the fastest candidate.

Each has a comment at the site explaining why. Read it before changing it.

## Logging

`src/lib/logger.ts` — JSON lines, child loggers, and a `redact()` pass over everything
written. Never log a credential; if you extend the redaction rules, extend
`tests/unit/logger.test.ts` with them.

The same `redact()` runs before request payloads are written to the database
(`src/lib/db/repos/log.ts`), so a client's own key never lands on disk in plain text.
Retention is applied on the health tick; `logRetentionDays: 0` means keep forever.

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

**No `Co-Authored-By` trailer.** The repository owner asked for it off and the history was
rewritten to remove it; do not reintroduce it.

## Releases

Automated — bumping `version` in `package.json` on `main` cuts the release branch, tag and
GitHub release. Never create those by hand; a manual tag blocks the workflow, which
deliberately refuses to move an existing one.

## Security

- Never commit `master.key`, `switchboard.db`, or anything under `data/`.
- Never add a credential to the `files` array in `package.json`; run
  `npm run pack:check` and confirm the tarball is clean.
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
