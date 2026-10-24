import { NextResponse, type NextRequest } from 'next/server';
import { adminGate, hostAllowed, hostDenied } from '@/lib/auth/access';
import { TOKEN_COOKIE, tokenMatches } from '@/lib/auth/session';

/**
 * Runs ahead of every page and API route (Next 16 runs proxies on Node).
 *
 * The dashboard pages are server components that read the database directly
 * (request logs with full prompts, API keys, connections), and they had no
 * guard at all: the localhost check lived only in the management API handlers.
 * Anything that could reach the port could read them. Checking in a layout
 * would not have been enough either, because a client-side navigation fetches
 * only the page segment and skips the layout.
 *
 * `/v1` is left to its own handlers, which authenticate with API keys and
 * apply the Host and Origin checks themselves; this only rejects a Host that
 * could be a DNS rebinding attempt.
 */
export function proxy(req: NextRequest): Response {
  const { pathname, searchParams } = req.nextUrl;

  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    return hostAllowed(req) ? NextResponse.next() : hostDenied();
  }

  // One-time handoff for a remote browser: `/dashboard?token=…` swaps the token
  // for an HttpOnly cookie and strips it from the URL, so it does not linger in
  // history, referrers or proxy logs.
  const token = searchParams.get('token');
  if (
    req.method === 'GET' &&
    token !== null &&
    !pathname.startsWith('/api/') &&
    hostAllowed(req) &&
    tokenMatches(token.trim())
  ) {
    const clean = req.nextUrl.clone();
    clean.searchParams.delete('token');
    const response = NextResponse.redirect(clean);
    response.cookies.set(TOKEN_COOKIE, token.trim(), {
      httpOnly: true,
      // Lax, not strict: with strict, following a link to the dashboard from
      // email or chat landed on the deny page. Cross-site writes are refused by
      // the Origin check regardless of the cookie.
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  const denied = adminGate(req);
  if (denied === null) return NextResponse.next();
  if (pathname.startsWith('/api/')) return denied;
  return deniedPage(denied.status);
}

function deniedPage(status: number): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Switchboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">This dashboard only answers its own machine</h1>
<p>Open it on the computer running Switchboard, or run <code>sb token</code> there and visit
<code>/dashboard?token=&lt;token&gt;</code> once from this browser.</p>
<p>If this host already sits behind your own authentication, start Switchboard with
<code>SWITCHBOARD_ALLOW_REMOTE=1</code>.</p>
</body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export const config = {
  // Static build assets carry nothing sensitive and are requested on every
  // page load; running the gate for each one would be pure overhead.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
