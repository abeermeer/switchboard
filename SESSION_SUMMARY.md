# Session summary

A running record of what was built, why, and what is still open. Newest first.

---

## 2026-07-25 — Test suite, global install, release automation

**Shipped:** `v0.2.0`, public at <https://github.com/abeermeer/switchboard>.

### The test suite

709 tests on vitest, in `tests/`. The audit that prompted this scored coverage **0/10**;
that is now closed for the routing core.

| Module | Coverage | Why it matters |
| --- | --- | --- |
| `router/score.ts` | 100% | Decides where every request goes |
| `usage/cost.ts` | 100% | Every figure on the dashboard and the bill |
| `providers/adapters/shared.ts` | 99% | Classifies every upstream error |
| `auth/rateLimit.ts` | 98% | Sliding window, easy to get subtly wrong |
| `router/candidates.ts` | 95% | Expansion plus every exclusion reason |
| `crypto/vault.ts` | 94% | Credentials at rest |
| `resilience/breaker.ts` | 100% stmts | Full state machine, including half-open |

Plus `tests/integration/gateway.test.ts`, which drives the real route handlers against a
stubbed `fetch` — including the fallback walk end to end: a 429 on the first provider, a
200 on the second, `x-switchboard-attempts: 2`, and the decision trace persisted.

Tests assert the behaviour the code's comments claim, so the deliberate decisions fail
loudly if anyone "simplifies" them away.

### The bug the tests found

HTTP header values are ByteStrings. `x-switchboard-fallback-reason` stripped CRLF but not
non-ASCII, so **any code point above 255 threw inside `new Response`** — turning a handled
upstream failure into an unhandled 500 and losing the client's real error.

Reachable two ways in normal operation: one of our own reason strings contained a
typographic apostrophe (`model’s`), and providers return non-English error text routinely.

Fixed with `headerSafe()` in `src/lib/api/handler.ts`, ASCII-only reason strings in
`src/lib/router/execute.ts`, and two regression tests using French and CJK payloads.

It had been in `main` since the first commit and survived every manual check.

### Global install — three bugs, one of them destructive

`npm install -g switchboard` did not work. Fixing it turned up:

1. **Next could not be resolved.** The CLI hardcoded `<root>/node_modules/next`, which
   only exists in a repo checkout; npm hoists on a global install. Now resolved through
   node's own resolver.
2. **No `files` allowlist.** `npm publish` would have shipped `data/` — the SQLite
   database and `master.key`, meaning every stored provider credential in a public
   tarball. The manifest now lists exactly what ships, and the release workflow fails if
   the tarball matches a secret-ish path.
3. **Upgrading destroyed the key vault.** The server inherited `cwd` from the package
   directory, so a global install wrote its database into
   `node_modules/switchboard/data` — which `npm update -g` deletes. The CLI now pins
   `SWITCHBOARD_DATA_DIR` to the OS application-data directory and prints it in the start
   banner.

Verified end to end: installed globally, started from outside the repo, served
`/v1/models` and `/dashboard`, and the data survived a reinstall.

### Release automation

`.github/workflows/release.yml` — bumping `version` in `package.json` on `main` cuts a
`release/vX.Y.Z` branch, a tag, and a GitHub release with the demo video attached. It
typechecks, tests, builds, boots the gateway, and verifies the publish tarball carries no
database or key before publishing. It refuses to move an existing tag.

Proven by the v0.2.0 release, which was produced entirely by the version bump.

### Also

- `sb --version` was a hardcoded literal still reporting `0.1.0` after the release; now
  read from the manifest.
- `closeDb()` added to `src/lib/db/client.ts` — needed by the tests, and wanted by an
  orderly shutdown regardless.
- CI runs the suite on all four legs (Node 22.13/24 × Ubuntu/Windows), not once: the tests
  touch `node:sqlite` and the filesystem, which is exactly what differs across platforms.
- Commit history rewritten to remove the `Co-Authored-By` trailer at the user's request.

### Findings recorded, not fixed

Surfaced while writing tests. Current behaviour is pinned by tests; these are judgement
calls, not clear bugs:

1. **`context_length` counts toward the breaker threshold**, unlike `bad_request`. A
   client looping oversized prompts can open the breaker on a healthy connection.
2. **Failure latency samples skew the p50.** `recomputeLatency` does not filter on `ok`,
   so a provider failing fast (~5 ms connection refused) can look like the *fastest*
   candidate to a latency-weighted strategy.
3. **A half-open trial that gets a 429 never reports back** — the trial slot stays held
   until its window expires.
4. **`rateLimitPerMin: 0.5` bricks a key permanently.** It floors to 0, blocks everything,
   and a blocked call records no hit, so it never recovers. Unreachable through
   `updateApiKey` (it truncates), reachable through `createApiKey`.

---

## 2026-07-24 — Initial build

Built from scratch in one session as a cleaner answer to
[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute). ~137 TypeScript files,
0 typecheck errors, verified running end to end.

**Decisions:** name *Switchboard*, CLI `sb`, port 7272, copper accent (the brass
patch-panel metaphor). Both themes designed separately rather than dark-mode bolted on.
Electron desktop app in scope.

**Deliberate divergences from OmniRoute:**

- `node:sqlite` rather than `better-sqlite3` — no native module, so a Windows install never
  meets node-gyp. Windows is in the CI matrix specifically to keep proving that.
- Routing decisions are **persisted and rendered**: every candidate, its eight weighted
  score factors, and the reason each loser was excluded. Other gateways emit a header.
- A **policy simulator** scores a routing policy without sending anything upstream, so the
  ranking can be tuned by watching it reshuffle.

**The free-tier rule**, which is the least obvious thing in the codebase: a provider's
published free allowance makes its smaller models cost **$0** — in tier inference, in the
policy cost ceiling, and in logged spend. The threshold is $1.00/MTok blended
(`FREE_TIER_COVERS_UP_TO` in `src/lib/providers/registry.ts`), which captures 8B and
Flash-class models while leaving flagships priced as what they are. Without it the
`free-only` policy matched nothing and the dashboard overstated spend by billing for
requests the user was never charged for. Everything settles through `settleRequest()`.

**Also shipped:** a 20-second launch video built from real captured output
(`brag-output/`), and a Node version correction — `node:sqlite` shipped in 22.5 but stayed
behind `--experimental-sqlite` until **22.13**, so the stated floor was wrong in six places
and `sb doctor` compared only the major version.
