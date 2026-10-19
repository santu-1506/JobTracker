import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jobtracker/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
