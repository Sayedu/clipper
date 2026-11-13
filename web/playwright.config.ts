import { defineConfig } from '@playwright/test';

const webPort = process.env.WEB_PORT ?? '3100';

export default defineConfig({
  testDir: './e2e',
  timeout: 360_000, // a full-quality render (no fast-test mode on this simplified page) can take a few minutes
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  // `npm run dev` (root) brings up worker + web + the colorwars API together;
  // reuseExistingServer means `npx playwright test` just uses it if it's
  // already running (as it normally will be during local development).
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    url: `http://localhost:${webPort}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
