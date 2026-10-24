# Changelog

Notable changes per release. The release workflow copies a version's section into its
GitHub release, so write each entry for someone deciding whether to upgrade.
[SESSION_SUMMARY.md](SESSION_SUMMARY.md) has the reasoning behind each change.

## 0.5.0

**Upgrade now if you run any earlier version on a machine other people can reach.**

### Security

- **Network takeover (every version through 0.4.1).** The server listened on every
  interface and decided whether a caller was local from `X-Forwarded-For`, which the client
  controls. Anyone who could reach the port and sent `X-Forwarded-For: 127.0.0.1` got full
  admin: they could mint API keys and spend every connected provider credential. The
  `/dashboard` pages had no guard at all. Now the server binds `127.0.0.1` by default,
  locality is read from the socket, any request carrying a forwarding header counts as
  remote, and every page and admin route requires the dashboard token from a remote caller.
  Production without `server.mjs` fails closed instead of trusting the header.
- **DNS rebinding, CSRF and clickjacking** through the user's own browser are refused:
  only IP literals, `localhost` and `SWITCHBOARD_ALLOWED_HOSTS` are answered, cross-site
  admin writes are rejected, and frames are denied.
- Per-key "allowed policies" were stored and never enforced. They are now checked on every
  request, including `/v1/audio/speech`. A key restricted to a policy that was later
  disabled, deleted or renamed gets 403 `policy_unavailable` instead of falling through to
  the default policy.
- The database file, which holds every logged prompt, is no longer world-readable.

### `free-only` no longer spends money

The `free-only` policy promises $0. It broke that promise four ways:

- **Paid OpenAI Whisper was priced as free.** Transcription is billed per audio minute,
  so the catalog's $0-per-token entry ranked `whisper-1` in the free tier and passed the $0
  ceiling. Transcription models are now unpriced: free only inside a provider's free tier
  (Groq), refused by every cost ceiling elsewhere.
- **OpenRouter's paid models** under the $1/MTok heuristic were tiered free and logged at
  $0 while billing the account. Only its `:free` models count as free now.
- **Restricted keys** fell through to the default policy when their policy went away
  (see Security).
- **Installs driven from the CLI or API had no `free-only` at all**, because the starter
  policies were only created when a dashboard page rendered; a request for it routed as an
  unknown model to paid providers. They are seeded at boot.

### Breaking

- Binds `127.0.0.1` by default. Set `SWITCHBOARD_HOST` to expose it.
- Production must run through `server.mjs` (`switchboard`, `npm start`, Docker, the desktop
  app), not bare `next start`.
- Remote callers need an API key or the dashboard token (`sb token`).
- Behind nginx, add `X-Forwarded-For`: a bare `proxy_pass` sends no forwarding header.
- The Linux desktop executable is now `switchboard-desktop`.

### Fixed

- The health loop had never run, so probes, latency pruning and log retention never
  happened and a 30-day retention setting kept every prompt forever. It starts at boot.
- Catalog ids containing a slash (`openai/gpt-oss-120b`, every OpenRouter id) returned 404.
- Skipped candidates used up `maxAttempts`, so one open breaker could end the fallback walk.
- Reasoning tokens were double-billed; the playground priced xAI-style reasoning ~98% low.
- Transcription requests carrying Whisper's optional `prompt` were always refused.
- SIGTERM now drains in-flight requests for up to 10 s, including in Docker.
- The CLI no longer switches to an empty database inside the clone; `sb chat` accepts
  `--key`; `sb start --host` shows the address it actually bound.
- `next.config.ts` is now `.mjs`, so a build missing the platform's SWC binary still starts.
- The desktop app's "Restart gateway" reloads onto the new process instead of the dead one.

### Known gaps

- Paid transcription still logs $0 spend; budgets cannot see per-minute billing.
