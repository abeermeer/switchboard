import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig. Set here rather than pulling in
    // vite-tsconfig-paths: one alias does not justify another dependency.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],

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
