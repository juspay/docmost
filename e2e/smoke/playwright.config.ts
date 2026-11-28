import { defineConfig } from '@playwright/test';

const baseURL = process.env.SMOKE_BASE_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: '.',
  testMatch: 'smoke.spec.ts',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  // The tests share one running instance, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The first page load after the client starts can take tens of seconds.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    viewport: { width: 1360, height: 860 },
    acceptDownloads: true,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.SMOKE_CHROME_PATH
      ? { executablePath: process.env.SMOKE_CHROME_PATH }
      : {},
  },
});
