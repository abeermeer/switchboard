import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
};

export default nextConfig;
