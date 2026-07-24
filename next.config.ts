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
  async headers() {
    return [
      {
        source: '/v1/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS,DELETE' },
        ],
      },
    ];
  },
};

export default nextConfig;
