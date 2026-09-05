import { defineConfig } from '@playwright/test';

/** Auth-enabled stack on :3200, isolated from the main (no-auth) suite. A
 *  stub of orcid.org on :4929 backs the ORCID sign-in tests; Google and
 *  GitHub stay unconfigured on purpose. */
const PORT = Number(process.env.E2E_AUTH_PORT || 3200);
const MOCK = Number(process.env.E2E_AUTH_MOCK_PORT || 4929);
const BASE = process.env.ALDINE_AUTH_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './auth-tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: process.env.ALDINE_AUTH_URL ? undefined : [
    {
      command: `E2E_AUTH_MOCK_PORT=${MOCK} node auth-tests/mock-orcid.mjs`,
      port: MOCK,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `npm run build -w apps/web && PORT=${PORT} AUTH_ENABLED=1 ALDINE_RESET_ECHO=1 ALDINE_TEST_HOOKS=1 TRUST_PROXY=1 RL_REGISTER_BURST=200 DATA_DIR=$(pwd)/.data-auth META_DIR=$(pwd)/.secrets-auth ORCID_CLIENT_ID=test-orcid ORCID_CLIENT_SECRET=test-orcid-secret ORCID_API_BASE=http://localhost:${MOCK} ORCID_PUB_API_BASE=http://localhost:${MOCK} npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
