#!/usr/bin/env node

/**
 * Production entry point: Next.js behind a plain Node HTTP server.
 *
 * `next start` was not enough, for two reasons that both decide who can reach
 * the dashboard:
 *
 * 1. It listens on every interface unless told otherwise, so a "local" gateway
 *    was reachable from anything on the same network. This binds 127.0.0.1
 *    unless SWITCHBOARD_HOST says otherwise.
 *
 * 2. Route handlers never see the socket. Next fills in `x-forwarded-for` from
 *    the socket only when the client did not send one, so a remote client that
 *    sends `X-Forwarded-For: 127.0.0.1` looked local and got full admin. This
 *    server reads the real peer address and stamps a verdict header that the app
 *    trusts only because this process set SWITCHBOARD_SERVER before Next loaded.
 *    A client can send the header, but it cannot set an environment variable.
 *
 * Every launcher goes through here: the CLI, the desktop shell, Docker and
 * `npm start`.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both must be in place before Next is imported: Next reads NODE_ENV at load,
// and the app reads SWITCHBOARD_SERVER to decide whether the verdict header is
// trustworthy.
process.env.NODE_ENV ??= 'production';
process.env.SWITCHBOARD_SERVER = '1';

const { default: next } = await import('next');

const root = dirname(fileURLToPath(import.meta.url));

// Next loads .env files during prepare(), which is after the listener's host
// and port are chosen, so SWITCHBOARD_HOST and PORT set there were ignored while
// every other variable took effect. Loaded here in Next's precedence order;
// a variable already in the environment is never overridden.
for (const file of ['.env.production.local', '.env.local', '.env.production', '.env']) {
  const path = join(root, file);
  if (existsSync(path)) process.loadEnvFile(path);
}

const port = Number.parseInt(process.env.PORT ?? '7272', 10);
const hostname = process.env.SWITCHBOARD_HOST?.trim() || '127.0.0.1';

/** Mirrors the names in src/lib/auth/session.ts. */
const CLIENT_HEADER = 'x-switchboard-client';
const PEER_HEADER = 'x-switchboard-peer';

/**
 * Any of these means a proxy relayed the request. The socket peer is then the
 * proxy, not the client. A reverse proxy on the same machine would otherwise
 * make every visitor from the internet look like localhost.
 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

/** "::ffff:10.0.0.5" and "10.0.0.5" are the same address. */
function plain(address) {
  if (typeof address !== 'string') return '';
  const lower = address.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function isLoopback(address) {
  const host = plain(address);
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** "Example.com:7272" -> "example.com", "[::1]:7272" -> "::1". */
function hostnameOf(host) {
  const value = host.trim().toLowerCase().replace(/\.$/, '');
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1];
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Whether the Host names this machine. A tunnel or proxy that adds no
 * forwarding header still usually passes on the name the visitor typed, which
 * is not localhost; requiring a local name catches those relays too.
 */
function hostIsLocal(host, ownAddress) {
  if (typeof host !== 'string' || host.trim() === '') return true;
  const name = hostnameOf(host);
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (isLoopback(name)) return true;
  return name === plain(ownAddress);
}

function stamp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const own = req.socket.localAddress ?? '';
  const relayed = FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
  // A connection from this machine to one of its own non-loopback addresses
  // (bound to a VPN interface, say) arrives with the peer equal to the local
  // address. Treating that as remote locked the owner out of `sb token`.
  const sameMachine = isLoopback(peer) || (peer !== '' && plain(peer) === plain(own));
  const local = !relayed && sameMachine && hostIsLocal(req.headers.host, own);
  // Assignment replaces whatever the client sent under the same names.
  req.headers[PEER_HEADER] = peer;
  req.headers[CLIENT_HEADER] = local ? 'local' : 'remote';
}

const app = next({ dev: false, dir: root, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  stamp(req);
  void handle(req, res);
});

server.on('error', (err) => {
  console.error(`Switchboard could not listen on ${hostname}:${port}: ${err.message}`);
  process.exit(1);
});

server.listen(port, hostname, () => {
  console.log(`Switchboard listening on http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`);
});

// Stop accepting connections and give in-flight requests, streams included,
// up to ten seconds to finish. Without a handler, `docker stop` sent SIGTERM to
// a PID 1 that ignored it and waited out its own ten-second kill timer.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
