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

import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both must be in place before Next is imported: Next reads NODE_ENV at load,
// and the app reads SWITCHBOARD_SERVER to decide whether the verdict header is
// trustworthy.
process.env.NODE_ENV ??= 'production';
process.env.SWITCHBOARD_SERVER = '1';

const { default: next } = await import('next');

const root = dirname(fileURLToPath(import.meta.url));
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

function isLoopback(address) {
  if (typeof address !== 'string') return false;
  const host = address.startsWith('::ffff:') ? address.slice(7) : address;
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function stamp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const relayed = FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
  // Assignment replaces whatever the client sent under the same names.
  req.headers[PEER_HEADER] = peer;
  req.headers[CLIENT_HEADER] = !relayed && isLoopback(peer) ? 'local' : 'remote';
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
