import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/checkers/',
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  server: { watch: process.env.POLL ? { usePolling: true, interval: 300 } : undefined },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
