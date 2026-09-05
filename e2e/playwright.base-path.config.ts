import { defineConfig } from '@playwright/test';

/**
 * The app served under a URL prefix (ALDINE_BASE_PATH=/internal/aldine) on
 * :3300, isolated from the root-path suites. baseURL is the bare origin on
 * purpose: Playwright resolves '/x' against the origin and would drop a path
 * in baseURL, so the specs spell the prefix out. The typeset test runs only
 * when a compiler shares this suite's data dir:
 *   DATA_DIR=$(pwd)/.data-base-path PORT=4022 node apps/compiler/server.js
 *   COMPILER_URL=http://localhost:4022 npm run test:e2e:base-path
 */
const PORT = Number(process.env.E2E_BASE_PATH_PORT || 3300);
const BASE = process.env.ALDINE_BASE_PATH_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './base-path-tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: process.env.ALDINE_BASE_PATH_URL ? undefined : {
    command: `npm run build -w apps/web && PORT=${PORT} ALDINE_BASE_PATH=/internal/aldine ALDINE_TEST_HOOKS=1 DATA_DIR=$(pwd)/.data-base-path META_DIR=$(pwd)/.secrets-base-path CACHE_DIR=$(pwd)/.data-base-path/cache npx tsx apps/server/src/index.ts`,
    cwd: '..',
    port: PORT,
    reuseExistingServer: true,
    timeout: 600_000,
  },
});
