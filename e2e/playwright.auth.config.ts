import { defineConfig } from '@playwright/test';

/** Auth-enabled stack on :3200, isolated from the main (no-auth) suite. */
const PORT = Number(process.env.E2E_AUTH_PORT || 3200);
const BASE = process.env.ALDINE_AUTH_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './auth-tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: process.env.ALDINE_AUTH_URL ? undefined : {
    command: `npm run build -w apps/web && PORT=${PORT} AUTH_ENABLED=1 ALDINE_MCP=1 ALDINE_RESET_ECHO=1 ALDINE_TEST_HOOKS=1 TRUST_PROXY=1 RL_REGISTER_BURST=200 DATA_DIR=$(pwd)/.data-auth META_DIR=$(pwd)/.secrets-auth npx tsx apps/server/src/index.ts`,
    cwd: '..',
    port: PORT,
    reuseExistingServer: true,
    timeout: 600_000,
  },
});
