// eslint-disable-next-line import/no-extraneous-dependencies
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PW_BASE_URL || 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    launchOptions: {
      // Pre-installed Chromium in this environment doesn't match this
      // @playwright/test version's pinned revision — point at the real
      // binary instead of letting Playwright try to download a new one.
      executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    },
  },
});
