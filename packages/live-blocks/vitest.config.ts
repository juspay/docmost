import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // the budget tests build large inputs; 5 s is too tight on a busy machine
    testTimeout: 30_000,
  },
});
