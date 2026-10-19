// Plain ESM rather than next.config.ts: a TypeScript config is transpiled with
// Next's native SWC binary every time the server starts, so a desktop build or
// install that lacked the matching platform binary could not start at all.
// Plain JavaScript needs nothing at runtime.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The gateway talks to upstream providers directly; nothing here should be
  // bundled for the edge runtime. node:sqlite and node:crypto stay external.
  serverExternalPackages: [],
  experimental: {
    // Streaming proxy responses are passed through untouched.
    proxyTimeout: 15 * 60 * 1000,
  },
  typescript: { ignoreBuildErrors: false },
  // CORS is deliberately not set here. A static header block cannot inspect the
  // request, so it could only ever emit `*` — which would hand any page in the
  // user's browser the ability to spend their provider credentials. The route
  // handlers set it per request via `corsHeaders()` in src/lib/api/respond.ts,
  // which reflects only origins the operator has allowed.
  async headers() {
    return [
      {
        // No page here is ever meant to be framed. Without these, a site could
        // load the dashboard in an invisible frame and steer the user's clicks,
        // which the same-origin write checks cannot see.
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
