# Deployment

Switchboard is local-first. Everything below assumes you control the machine it runs on.

## Local

```bash
npm install
npm run build
npm start          # server.mjs on 127.0.0.1:7272
```

Or via the CLI, which prints the endpoint banner and can open the dashboard:

```bash
node bin/sb.mjs start --open
```

Both run `server.mjs`, which binds `127.0.0.1` unless `SWITCHBOARD_HOST` (or
`sb start --host`) says otherwise, and decides who is local from the socket rather than
from a header. Bare `next start` skips both; do not use it outside development.

`sb start` keeps state in the OS app-data folder (below, under Desktop); `npm start` and
`npm run dev` keep it in `./data` unless `SWITCHBOARD_DATA_DIR` is set:

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
  -p 127.0.0.1:7272:7272 \
  -v switchboard-data:/data \
  switchboard
```

Inside the container the server listens on `0.0.0.0` (the image sets
`SWITCHBOARD_HOST`), because the published port arrives on the container's own interface.
What can reach it is decided by `-p`: `127.0.0.1:7272:7272` keeps it on the host.

Requests through Docker's port forward come from the bridge, so they count as remote. Open
the dashboard with the token:

```bash
docker exec switchboard node bin/sb.mjs token
# then visit http://127.0.0.1:7272/dashboard?token=<token> once
```

or, when the port is published on loopback only, add `-e SWITCHBOARD_ALLOW_REMOTE=1`.

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
  -p 127.0.0.1:7272:7272 \
  switchboard
```

Store that value somewhere you will still have it after the container is gone.

### Compose

```yaml
services:
  switchboard:
    build: .
    ports:
      - '127.0.0.1:7272:7272'
    volumes:
      - switchboard-data:/data
    environment:
      SWITCHBOARD_ALLOW_REMOTE: '0'
    restart: unless-stopped

volumes:
  switchboard-data:
```

## Exposing it beyond localhost

By default the server listens on loopback only, and the dashboard and management API
refuse anything that is not local. That is deliberate: the dashboard can create API keys,
read stored request payloads and change routing, so it is not something to hang off a
public interface casually.

If you need LAN access, listen on the network and use the dashboard token:

```bash
sb start --host 0.0.0.0        # or SWITCHBOARD_HOST=0.0.0.0 npm start
sb token                       # run on the host; prints the dashboard token
```

Open `http://<host>:7272/dashboard?token=<token>` once from the other machine; the token
becomes an HttpOnly cookie. Scripts send it in the `x-switchboard-token` header. Remote
gateway callers always need an API key, even before you have created one for local use.

Even so, put it behind a reverse proxy with TLS, or a WireGuard/Tailscale interface. Do
not expose it directly to the internet. Anyone who reaches the management API can read
every prompt you have logged.

If you proxy it, every relayed request counts as remote, because the proxy is the only
thing the socket sees. Either keep using the token, or set `SWITCHBOARD_ALLOW_REMOTE=1` if
the proxy enforces its own authentication. Add the proxy's hostname to
`SWITCHBOARD_ALLOWED_HOSTS`, keep the original `Host`, and disable response buffering so
streaming works:

```nginx
location / {
  proxy_pass http://127.0.0.1:7272;
  proxy_set_header Host $host;
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

The packaged app runs `server.mjs` as a child Node process on a free port starting at 7272,
bound to `127.0.0.1`, and writes to the same OS app-data directory as the CLI:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\Switchboard` |
| macOS | `~/Library/Application Support/Switchboard` |
| Linux | `~/.local/share/Switchboard` |

Closing the window hides to the tray; the gateway keeps serving. Quit from the tray menu.

Icons are generated into `electron/assets/` by `npm run icons`. CI's desktop workflow
builds the Windows and Linux packages, launches each one, and waits for its gateway to
answer, so an installer that cannot start its server fails the build.

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
