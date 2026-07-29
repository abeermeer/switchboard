# Session summary

A running record of what was built, why, and what is still open. Newest first.

## Releases

| Version | What it was |
| --- | --- |
| **v0.4.1** | The published install actually works: the npm package is now **`switchboard-gateway`** (plain `switchboard` is someone else's library), `/api/system/status` reports the real version, and CI installs the packed tarball to prove the command exists. |
| **v0.4.0** | Closes the second round of audit findings: adapter wire-translation tests (adapters 27% → 80%), management API route tests, log retention actually enforced, request payloads redacted before they reach disk, and desktop packaging verified in CI rather than assumed. |
| **v0.3.0** | Closes every remaining audit finding. **Breaking:** `/v1` no longer sends a wildcard `Access-Control-Allow-Origin`, so a browser client must now list its origin in `SWITCHBOARD_CORS_ORIGINS`. Server-side SDK clients are unaffected. |
| **v0.2.0** | The test suite (0 → 709), a working global install, and release automation. |
| **v0.1.0** | First public release: the gateway, dashboard, CLI and desktop shell. |

Releases are cut automatically by a version bump on `main` — see
[README](README.md#releases). Never tag by hand; the workflow refuses to move an existing
tag, so a manual one blocks the real release.

---

## 2026-07-30 (later) — The install instruction was pointing at someone else's package

The user ran the README's first command and got
`switchboard : The term 'switchboard' is not recognized...`. The install had succeeded —
`added 2 packages, removed 64 packages` — because **`switchboard` on npm is not ours**. It is
an unrelated event-listener library from 2022, version 1.3.0, with no `bin` field at all. So
`npm install -g switchboard` installed that, created no command, and the failure looked like a
bug in our CLI.

The package had never been published under a name we own, and the README had said otherwise
since v0.1.0.

### What was wrong with the pipeline, not just the name

Everything upstream was green and none of it could have caught this. Typecheck, 1,033 tests,
four build legs, a booted gateway, a tarball-contents check — every one of them runs against
the *repository*. Nothing ever installed the artefact and typed the command. `npm pack
--dry-run` proved the tarball's contents were clean; it says nothing about whether the name
on the label belongs to you.

### Fixes

- **Renamed to `switchboard-gateway`** (verified unregistered). The commands are unchanged —
  `bin` still installs `switchboard` and `sb`, so only the install line got longer.
- **`scripts/verify-package-name.mjs`** — asks the registry whether the name in
  `package.json` is unregistered or published from this repository, and fails if someone else
  holds it. Runs on every CI leg; one HTTP GET. Tested against the squatted name, where it
  fails with the actual owner's repository URL in the message.
- **`scripts/verify-global-install.mjs`** — packs the tarball, installs it into a throwaway
  global prefix, and runs `switchboard --version` and `sb --version` through the real shims,
  asserting the reported version matches the manifest and that `.next` shipped. This is the
  check that was missing. It runs on all four CI legs and before every release.
- **Gated `npm publish` in the release workflow** — fires only when an `NPM_TOKEN` secret
  exists, so a release without one still cuts its branch, tag and GitHub release.

### A second bug the install test surfaced

Booting the installed copy showed `/api/system/status` returning `"version": "0.1.0"` — a
hardcoded literal, from a 0.4.0 install. That is the worst possible lie for that field: it is
what someone reads to decide whether an upgrade took effect. Now read from the manifest
(`src/lib/version.ts`), with two tests pinning it to `package.json` so the literal cannot
come back.

Verified by installing the real tarball to a temp prefix, running the CLI, booting the
gateway on :7399 and probing `/api/system/status` and `/v1/models` — both 200, version
`0.4.1`.

---

## 2026-07-30 — Closing the second round of audit findings

A follow-up audit named four gaps once the first six were closed. All four were verified
against the code, all four were accurate, and all four are now closed. Suite 852 → **1,033
tests**; overall coverage **75.47%**.

### Adapter translation coverage: 27% → 80%

The shared adapter *helpers* were at 99% while the three non-OpenAI adapters themselves sat
at 27% — meaning the error taxonomy was well tested but the actual request and response
translation was not, and that is where a silent bug produces a wrong answer rather than a
loud failure. 121 tests across `anthropicAdapter` (44), `googleAdapter` (40) and
`cohereAdapter` (37), each driving the real `execute()` path with `fetch` stubbed by
`stubAdapterUpstream()`, so one test covers the URL, the auth scheme, both translation
directions and the error classification together. Streaming tests include frames split
across chunk boundaries.

**Two of my own assumptions were wrong, not the code.** Google authenticates with an
`x-goog-api-key` header rather than `?key=`, which is the better choice — a key in a query
string leaks into every proxy and access log on the path. And its REST surface takes
snake_case `inline_data` / `mime_type`, not the camelCase the client libraries expose. The
tests were fixed and a `file_data` case added for remote images.

### Management API route tests

47 integration tests in `tests/integration/adminApi.test.ts`, driving the real route
handlers: connections, keys, policies, settings, health and the simulator. The simulator
test deliberately runs with **no fetch stub installed at all**, so if that endpoint ever
started reaching a provider the test would fail by throwing rather than by passing quietly.

### Log retention was a setting that did nothing

`logRetentionDays` was in settings, rendered in the UI, and read by nothing. Rows
accumulated forever. `enforceLogRetention()` now runs on the health tick beside the lockout
and latency-sample sweeps. `0` still means keep forever — that is a legitimate choice, so it
stays a no-op rather than becoming "prune everything".

### Payload redaction at the storage boundary

Every request log row stores the request body, the response and the routing decision. A
client sending its own provider key in a header, or pasting one into a prompt, had it written
to disk in plain text and kept for as long as the row lived. `redact()` now runs in
`writePayloads` on the way *in* — not on the dashboard's read path, because the read path is
not the only thing that can reach that table.

### Desktop packaging verified rather than assumed

`scripts/verify-electron.mjs` — 11 checks, on every CI leg: the builder config loads and
names an entry point that exists, every referenced icon exists with correct magic bytes
**and** PNG dimensions, `main.cjs`/`preload.cjs` compile via `vm.Script`, the preload uses
`contextBridge` without exposing `ipcRenderer` wholesale, and `contextIsolation` /
`nodeIntegration: false` / `sandbox` / `setWindowOpenHandler` are all still present.

The expensive half is `.github/workflows/desktop.yml`: a real `electron-builder` run
producing an NSIS installer on Windows and an AppImage on Linux, which then asserts the
artefact is **larger than 20 MB** — electron-builder exits 0 having shipped only the shell
when the `files` globs are wrong, so existence alone proves nothing. First run produced
143 MB and 193 MB.

My first version of the verifier flagged the tray icon as "implausibly small (443 bytes)".
That was a false positive: a 32px tray glyph legitimately is that small. File size was the
wrong signal; the check now reads the PNG IHDR and enforces a per-icon minimum edge.

---

## 2026-07-25 (later) — Closing the audit's remaining findings

An external audit listed six remaining gaps. All six were verified against the code — every
one was accurate — and all six are now closed.

### Latency samples skewed the router (a real routing bug)

`recomputeLatency` selected every sample in the window regardless of outcome, and failures
are recorded as samples too. A refused connection or an instant 401 returns in single-digit
milliseconds, so **a provider that was reliably down posted the best p50 in the fleet** —
and the `fastest` strategy then actively preferred it. The query now filters on `ok = 1`.
Two regression tests, including one asserting that a connection which has only ever failed
reports `null` rather than "instant".

### Structured logging with redaction

Three bare `console.error` calls were the whole observability story. Logs are now one JSON
object per line (pretty in a TTY), with child loggers stamping a `requestId` across a
request. Covered events: a breaker opening or closing, a model lockout and whether the
provider supplied the duration or we guessed, a routing failure with per-attempt reasons,
and a successful fallback — the client saw a 200 there, so the log is the only place the
recovery is visible.

Written rather than pulling in pino, deliberately: the redaction rules had to be written
for this codebase either way, and owning them means they can be tested exhaustively. 52
tests cover every secret-ish key name, five providers' credential formats hiding under
innocent keys, nested structures, error messages, and the regex `lastIndex` reset that
would otherwise make every other call silently miss.

### CORS wildcard closed

`/v1` sent `Access-Control-Allow-Origin: *` to everyone. The gateway holds every provider
credential the user owns, so that handed any page in their browser the ability to spend
them once it learned a key. The default is now no CORS at all — the endpoint is for
server-side SDK clients, which are unaffected by it — and a browser app opts in by listing
origins, which are reflected rather than wildcarded, with `Vary: Origin`.

### Rate limiting persisted

In memory, a restart handed every key a fresh allowance: a crash-looping client or an
operator restarting to apply a setting silently lifted the cap. Now in SQLite (migration 2),
counting hits per second rather than per request, so a key doing 10k/minute writes 60 rows
in a window instead of 10,000.

Fixed a real bug while in there: the guard ran *before* the floor, so `rateLimitPerMin: 0.5`
passed a `> 0` check, floored to 0, and refused every request forever — a blocked call
records no hit, so nothing aged out and the key could never recover.

### Electron icons

`electron/assets/` did not exist, so every desktop installer shipped with the stock Electron
logo. Icons are now generated from the same patch-panel mark the sidebar draws
(`npm run icons`), as code rather than checked-in binaries so they cannot drift from the UI.

### Component tests

43 components had none. Added tests for the UI primitives (through their accessible surface
— role, name, `aria-*` — so they fail when a component becomes unusable rather than when a
class changes), `LiveProvider`'s reconnection and escalating backoff against a controllable
fake `EventSource`, and the policy editor's chain reordering.

**Suite: 852 tests across 13 files.**

### Also fixed in passing

- **CI was green on Node 24 and red on 22.13.** The shared test setup imported the database
  client unconditionally, so a jsdom file pulled `node:sqlite` into a browser-target bundle
  — which Vite on 22.13 refuses to resolve, not yet recognising it as a builtin. Guarded on
  `typeof window`; the suite also got about three times faster, because every node file had
  been loading jsdom matchers it never used.
- **`sb --version` reported the wrong number.** It was a hardcoded literal; now read from
  the manifest.

### Judgement calls worth revisiting

- **The logger is hand-written rather than pino**, which the audit specifically
  recommended. The redaction rules had to be written for this codebase either way, owning
  them makes them exhaustively testable, and pino's worker-thread transports are a known
  friction point under Next's bundler. Swapping to pino later is a contained change — every
  call site goes through `src/lib/logger.ts`.
- **CORS defaults to off rather than to an allowlist of localhost ports.** Anything running
  in a browser against a fresh install has to set `SWITCHBOARD_CORS_ORIGINS` explicitly.
  That is the safe default, but it is a default that will generate support questions.

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
   *(Still open.)*
2. ~~**Failure latency samples skew the p50.**~~ *Fixed later the same day — see above.*
3. **A half-open trial that gets a 429 never reports back** — the trial slot stays held
   until its window expires. *(Still open.)*
4. ~~**`rateLimitPerMin: 0.5` bricks a key permanently.**~~ *Fixed later the same day.*

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
