import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Node 22.13 predates Vite's recognition of `node:sqlite` as a builtin, so a
  // client-target bundle that touches it fails to resolve. Marking it external
  // keeps the behaviour identical across the supported Node range instead of
  // passing on 24 and failing on 22.13.
  optimizeDeps: { exclude: ['node:sqlite'] },
  ssr: { external: ['node:sqlite'] },

  resolve: {
    // Mirrors the `@/*` path alias in tsconfig. Set here rather than pulling in
    // vite-tsconfig-paths: one alias does not justify another dependency.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],

    // Node by default — most of the suite is the gateway, and jsdom would only
    // slow it down. Component tests opt into a DOM per file with the
    // `@vitest-environment jsdom` docblock.
    environment: 'node',

    // Every test file gets its own process, and therefore its own SQLite handle
    // and its own module-scope caches (the master key, the db handle, the rate
    // limiter's Map). Sharing a worker across files would let one file's state
    // leak into the next and produce failures that only appear in CI ordering.
    pool: 'forks',
    isolate: true,

    testTimeout: 15_000,
    hookTimeout: 15_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/db/schema.ts', '**/*.d.ts'],
    },
  },
});
