# CLAUDE.md

Working notes for Claude Code (and any agent) in this repository. Read this before
changing anything under `src/`.

## What this is

**Switchboard** — a local-first AI gateway. One OpenAI-compatible endpoint in front of 16
LLM providers, routing free-tier-first with automatic fallback, and persisting the reasoning
behind every routing decision.

It was built from scratch as a cleaner answer to
[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute). Do not copy code or
architecture from there.

## Commands

```bash
npm run dev          # dev server on :7272
npm run typecheck    # tsc --noEmit — must be clean before any commit
npm run test:run     # vitest, ~700 tests, must be green before any commit
npm run build        # production build; CI runs this on 4 platform/version combos
npm start            # serve the production build
node bin/sb.mjs doctor   # diagnose a local install
```

Node **22.13+** is required. `node:sqlite` shipped in 22.5 but stayed behind
`--experimental-sqlite` until 22.13 — anything older dies with
`ERR_UNKNOWN_BUILTIN_MODULE` during the build's page-data collection, which is a confusing
place to land. Do not lower this floor without checking that flag history again.

## Architecture in one paragraph

A request enters at `src/app/v1/*`, goes through the shared pipeline in
`src/lib/api/handler.ts` (parse → validate → authenticate → route → respond → log), and the
routing itself is three steps in `src/lib/router/`: `candidates.ts` expands the client's
`model` string into every connection+model pair that could serve it, `score.ts` ranks them
on eight weighted factors, and `execute.ts` walks the ranked list until one succeeds.
Everything persists through `src/lib/db/repos/`.

Full detail: [docs/architecture.md](docs/architecture.md).

## Hard rules

These are load-bearing. Breaking one produces a bug that typechecks.

- **`src/types/core.ts` is the contract.** It imports nothing; everything imports from it.
  Change a shared shape there first and let the compiler find the rest.
- **`verbatimModuleSyntax` is on** — type-only imports must be `import type`.
- **`noUncheckedIndexedAccess` is on** — `arr[0]` is `T | undefined`. Use `!` only where the
  index is provably in range; otherwise guard.
- **No `any`.** Use `unknown` and narrow.
- **Never import a server module from a `'use client'` component.** Anything touching
  `node:sqlite`, `node:crypto`, or `node:fs` is server-only. This fails at build, not at
  typecheck.
- **Route handlers that touch the DB** need `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`.
- **Next 16 route params are async**: `{ params }: { params: Promise<{ id: string }> }`.
- **Migrations in `src/lib/db/schema.ts` are append-only.** Never edit a shipped migration;
  add the next version. `user_version` drives what runs.
- **`node:sqlite` binds only** `null | number | string | bigint | Uint8Array`. Booleans go
  through `toInt()`. `undefined` must become `null`.
- **Nothing in the browser may read `document` or `window` during render.** SSR has neither.
  This already caused every dashboard page to 500 once — a `document.documentElement` read
  inside a `useMemo` in `CommandPalette.tsx`. Put browser reads in `useEffect` or an event
  handler.

## Styling

The dashboard runs on a token layer in `src/app/globals.css`. Use only the semantic
utilities — `bg-surface`, `bg-surface-2`, `text-ink`, `text-muted`, `text-faint`,
`border-line`, `text-accent`, `bg-accent-soft`, `text-ok`, `text-warn`, `text-down`,
`rounded-sb`, `shadow-sb`, `.tabular`.

**No hex codes. No `bg-gray-*`. No `dark:` variants.** Light and dark are tuned separately
in the token layer, so anything built on the tokens works in both for free, and anything
that hardcodes a colour is broken in one of them. Tailwind extracts class names statically,
so `text-${tone}` never reaches the stylesheet — write the branches out.

## Things that look wrong but are deliberate

Do not "fix" these:

- **The gateway runs unauthenticated until the first API key exists.** A fresh install has
  to be usable before the user has opened the dashboard.
- **`bad_request` (400) does not trigger a fallback.** A malformed body produces the same
  400 on every provider; retrying five times makes the client wait five times as long for
  the same answer.
- **A stream that has emitted its first byte is never retried.** The client has already
  committed to that response; switching providers mid-stream splices two completions.
- **Free-tier models are priced at $0** in routing, in the cost ceiling, and in logged
  spend — see `settleRequest` in `src/lib/usage/cost.ts`. A request inside a provider's
  published free allowance genuinely costs nothing, and charging list price for it would
  both misrank the free-first ladder and overstate the user's spend.
- **An empty combo member chain means "consider every eligible connection."** It is the
  default and usually correct, not an unconfigured state.
- **The CLI pins `SWITCHBOARD_DATA_DIR` when it spawns the server.** Without it, a global
  install writes the database into `node_modules/switchboard/data`, and the next
  `npm update -g` deletes it along with every sealed credential.

## Adding a provider

If it speaks the OpenAI wire format, this is one entry in `src/lib/providers/catalog.ts`
and no other change — 13 of the 16 do. Template in
[docs/development.md](docs/development.md#adding-a-provider).

**Pricing must come from the provider's own pricing page.** It drives the cost factor, the
tier ladder, the budget ceilings, and every figure in analytics. A guessed price silently
corrupts all of them.

## Tests

```bash
npm run test         # watch
npm run test:run     # once
npm run test:ci      # with coverage
```

~850 tests in `tests/`, on vitest. Structure:

- `tests/setup.ts` repoints `SWITCHBOARD_DATA_DIR` at a temp directory **before any module
  is imported**. This is load-bearing: the master key and the DB handle cache in module
  scope on first use, so a test that imported the vault first would seal against the
  developer's real key.
- `tests/helpers/db.ts` — `freshDb()` per test, `dropDb()` after. Any suite that writes
  rows must use them; tests must not depend on ordering.
- `tests/helpers/upstream.ts` — stubs global `fetch`, which is where every adapter reaches
  the network. The plan array is consumed one entry per upstream call, so
  `[providerError(429), chatOk()]` describes a fallback. **Nothing in the suite may reach a
  real provider.**
- `tests/components/*.test.tsx` — opt into a DOM with a `@vitest-environment jsdom`
  docblock at the top of the file. Test through the accessible surface (role, name,
  `aria-*`) rather than markup, so a test fails when the component becomes unusable rather
  than when a class name changes.

Write tests against the behaviour the comments describe, not for line coverage. Every
"deliberate" decision below has a test that fails if someone simplifies it away — that is
what those tests are for.

## Commits

**Do not add a `Co-Authored-By: Claude` trailer.** The user asked for it off, and the
history was rewritten on 2026-07-25 to strip it from every commit. Adding it back would
reintroduce what was deliberately removed.

Present tense, imperative subject. Put the reasoning in the body when the diff does not
carry it — most commits here explain a decision, not a change.

## Before committing

```bash
npm run typecheck && npm run test:run && npm run build
```

All three are enforced in CI across Node 22.13/24 on Ubuntu and Windows. Windows is in the
matrix deliberately: storage is `node:sqlite` precisely so installs never need a native
toolchain, and that claim is worth proving on every commit.

## Known gaps

Be honest about these rather than papering over them:

- **Coverage is uneven.** The routing core is well covered (score 100%, cost 100%, adapter
  helpers 99%, candidates 95%, rate limit 100%), and there are component tests for the UI
  primitives, `LiveProvider` and the policy editor. The DB repositories, the management API
  routes and most dashboard pages have none, and there are no end-to-end tests.
- **`context_length` counts toward the breaker threshold**, unlike `bad_request`. A client
  looping oversized prompts can open the breaker on a healthy connection.
- **A half-open trial that gets a 429 never reports back** — the trial slot stays held
  until its window expires.
- **No audit log of admin actions** — key creation, connection changes and token rotation
  are not recorded anywhere.
- **No graceful shutdown** — SIGTERM kills in-flight streams rather than draining them.

[SESSION_SUMMARY.md](SESSION_SUMMARY.md) records what changed in each session and why.
Roadmap for the gaps lives in the audit documents the user maintains outside the repo.

## Releases

Automated. Bumping `version` in `package.json` on `main` makes
`.github/workflows/release.yml` cut the `release/vX.Y.Z` branch, the tag, and the GitHub
release with the demo video attached. **Do not create any of those by hand** — the
workflow refuses to move an existing tag, so a manual tag blocks the real release.
