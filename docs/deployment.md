# Deployment

Switchboard is local-first. Everything below assumes you control the machine it runs on.

## Local

```bash
npm install
npm run build
npm start          # :7272
```

Or via the CLI, which prints the endpoint banner and can open the dashboard:

```bash
node bin/sb.mjs start --open
```

State lives in `./data`:

| File | Contents |
| --- | --- |
| `switchboard.db` | Everything — connections, policies, logs, usage |
| `switchboard.db-wal`, `-shm` | WAL journal |
| `master.key` | 32 random bytes, `0600`, encrypts your provider credentials |

**Back up both `switchboard.db` and `master.key`.** The database without the key is
unreadable credentials; the key without the database is nothing.

## Docker

```bash
docker build -t switchboard .
docker run -d \
  --name switchboard \
  -p 7272:7272 \
  -v switchboard-data:/data \
  switchboard
```

The image is `node:24-slim`, multi-stage, and runs as the unprivileged `node` user.
Because storage is `node:sqlite` there is no native module to compile, so no
`build-essential` stage and no toolchain in the final image.

`/data` must be a volume. Without it your database and master key vanish with the
container.

To inject the master key rather than letting the container generate one:

```bash
docker run -d \
  -e SWITCHBOARD_MASTER_KEY="$(openssl rand -base64 32)" \
  -v switchboard-data:/data \
  -p 7272:7272 \
  switchboard
```

Store that value somewhere you will still have it after the container is gone.

### Compose

```yaml
services:
  switchboard:
    build: .
    ports:
      - '7272:7272'
    volumes:
      - switchboard-data:/data
    environment:
      SWITCHBOARD_ALLOW_REMOTE: '0'
    restart: unless-stopped

volumes:
  switchboard-data:
```

## Exposing it beyond localhost

By default the management API refuses anything that is not loopback. That is deliberate:
the dashboard can create API keys, read stored request payloads and change routing, so it
is not something to hang off a public interface casually.

If you need LAN access:

```bash
SWITCHBOARD_ALLOW_REMOTE=1 npm start
```

Then non-loopback requests must carry the dashboard token, readable from
`/api/settings` on the machine itself.

Even so — put it behind a reverse proxy with TLS, or a WireGuard/Tailscale interface. Do
not expose it directly to the internet. Anyone who reaches the management API can read
every prompt you have logged.

If you proxy it, forward `X-Forwarded-For` (the IP check reads it) and disable response
buffering so streaming works:

```nginx
location / {
  proxy_pass http://127.0.0.1:7272;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_buffering off;
  proxy_read_timeout 900s;
}
```

`proxy_buffering off` matters. Nginx buffers SSE by default, which silently converts a
streaming response into one delayed blob. Switchboard sets `x-accel-buffering: no` on
streams, which nginx honours, but the explicit setting is safer.

## Desktop

```bash
npm run electron:build:win     # NSIS installer
npm run electron:build:mac     # dmg, arm64 + x64
npm run electron:build:linux   # AppImage + deb
```

Output lands in `release/`.

The packaged app spawns the gateway as a child process on a free port starting at 7272,
sets `SWITCHBOARD_PACKAGED=1`, and writes to the OS app-data directory:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\Switchboard` |
| macOS | `~/Library/Application Support/Switchboard` |
| Linux | `~/.local/share/Switchboard` |

Closing the window hides to the tray; the gateway keeps serving. Quit from the tray menu.

Icons belong at `electron/assets/icon.{ico,icns,png}`. The build works without them —
electron-builder falls back to the stock Electron icon.

## Upgrading

Migrations run automatically on boot and are append-only, so a newer build reads an older
database. There is no downgrade path: once a migration has run, an older build will not
understand the schema. Copy `switchboard.db` before a major upgrade if that matters to you.

## Health checks

```bash
curl -f http://127.0.0.1:7272/api/system/status
```

Returns provider counts by status and today's spend. The Docker image has this wired as a
`HEALTHCHECK` already.
