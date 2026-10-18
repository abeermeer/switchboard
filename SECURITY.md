# Security

## Reporting a vulnerability

Do not open a public issue. Report privately through
[GitHub Security Advisories](https://github.com/abeermeer/switchboard/security/advisories/new).

Include what you did, what happened, and what you expected. A proof of concept helps.
Expect an acknowledgement within a few days.

## Threat model

Switchboard is **local-first single-user software**. It assumes:

- It runs on hardware you control.
- Anyone who can reach the dashboard is you.
- The machine itself is not already compromised.

It is **not** built to be a multi-tenant service. There is no user model, no per-user
isolation, and no audit trail of who did what. If you need those, this is the wrong tool.

## What is protected

**Provider credentials at rest.** Sealed with AES-256-GCM before they touch disk. The key
lives in `<data-dir>/master.key` with `0600` permissions, or comes from
`SWITCHBOARD_MASTER_KEY`. No endpoint returns a stored credential — the dashboard only ever
sees a four-character hint.

**Client API keys.** Only a SHA-256 hash is stored. The plaintext is shown once at creation
and cannot be recovered. These are high-entropy random secrets, so a slow KDF would buy
nothing and cost a hash on every request.

**Network exposure.** `server.mjs` listens on `127.0.0.1` unless `SWITCHBOARD_HOST` says
otherwise. Whether a caller is local is read from the socket, not from `X-Forwarded-For`,
and a request relayed by any proxy counts as remote. (Before this, the forwarded header
decided it, and a remote client that sent `X-Forwarded-For: 127.0.0.1` got full admin.)

**The dashboard and management API.** Every page and admin route, enforced in
`src/proxy.ts` and again in each handler, refuses a remote caller unless it presents the
dashboard token (header, or the HttpOnly cookie set by `/dashboard?token=`) or
`SWITCHBOARD_ALLOW_REMOTE=1` is set. Only a shell on the host can read or rotate the token
(`sb token`).

**Attacks from your own browser.** Both arrive from `127.0.0.1`, so the localhost check
cannot see them:
- *DNS rebinding:* only IP addresses, `localhost` and names in `SWITCHBOARD_ALLOWED_HOSTS`
  are answered, so a page that re-points its own domain at your machine is refused.
- *Cross-site requests:* state-changing admin requests from another origin or site are
  refused, and `/v1` refuses browser origins not listed in `SWITCHBOARD_CORS_ORIGINS`.

## What is not protected

Be clear-eyed about these:

- **Prompts are stored in plain text** when payload logging is on (it is on by default).
  Anyone with read access to `switchboard.db` can read every prompt and completion you have
  sent. Turn it off in Settings if that matters.
- **`master.key` sits next to the database.** Anyone who can read the data directory can
  decrypt your provider credentials. Its `0600` permissions are the only barrier, and on
  Windows those are advisory.
- **There is no rate limit on the dashboard**, only on gateway API keys.
- **The gateway runs open until you create an API key, for this machine.** This is
  deliberate, so a fresh install is usable before you have visited the dashboard. Remote
  callers always need a key. But any other user or process on the same machine can use an
  open gateway, so create a key on a shared machine.

## Deployment

Do not expose the management API to the internet. It can create API keys, read stored
prompts, and change routing. Put it behind a VPN interface (WireGuard, Tailscale) or a
reverse proxy with TLS and authentication.

Back up **both** `switchboard.db` and `master.key`. The database without the key is
unreadable credentials; the key alone is nothing.

## Supported versions

Pre-1.0. Fixes land on `main` only. There are no backported patch releases yet.
