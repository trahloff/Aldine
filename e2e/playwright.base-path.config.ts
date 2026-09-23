import { defineConfig } from '@playwright/test';

/**
 * The app served under a URL prefix (ALDINE_BASE_PATH=/internal/aldine) on
 * :3300, isolated from the root-path suites. baseURL is the bare origin on
 * purpose: Playwright resolves '/x' against the origin and would drop a path
 * in baseURL, so the specs spell the prefix out. The typeset test runs only
 * when a compiler shares this suite's data dir:
 *   DATA_DIR=$(pwd)/.data-base-path PORT=4022 node apps/compiler/server.js
 *   COMPILER_URL=http://localhost:4022 npm run test:e2e:base-path
 * A second, auth-enabled server under the same prefix (E2E_BASE_PATH_AUTH_PORT)
 * signs in through mock-oidc (E2E_BASE_PATH_OIDC_PORT); a second checkout
 * overrides both. It serves the web build the first server made, so it must
 * stay after that one in the list.
 */
const PORT = Number(process.env.E2E_BASE_PATH_PORT || 3300);
const BASE = process.env.ALDINE_BASE_PATH_URL || `http://localhost:${PORT}`;
const AUTH_PORT = Number(process.env.E2E_BASE_PATH_AUTH_PORT || 3302);
const OIDC_PORT = Number(process.env.E2E_BASE_PATH_OIDC_PORT || 4935);

export default defineConfig({
  testDir: './base-path-tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: process.env.ALDINE_BASE_PATH_URL ? undefined : [
    {
      command: `npm run build -w apps/web && PORT=${PORT} ALDINE_BASE_PATH=/internal/aldine ALDINE_TEST_HOOKS=1 ALDINE_MCP=1 ALDINE_MCP_TOKEN=aldine-e2e-mcp DATA_DIR=$(pwd)/.data-base-path META_DIR=$(pwd)/.secrets-base-path CACHE_DIR=$(pwd)/.data-base-path/cache npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
    {
      command: `E2E_AUTH_OIDC_PORT=${OIDC_PORT} node auth-tests/mock-oidc.mjs`,
      port: OIDC_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `PORT=${AUTH_PORT} AUTH_ENABLED=1 ALDINE_BASE_PATH=/internal/aldine ALDINE_PUBLIC_URL=http://localhost:${AUTH_PORT}/internal/aldine DATA_DIR=$(pwd)/.data-base-path-auth META_DIR=$(pwd)/.secrets-base-path-auth CACHE_DIR=$(pwd)/.data-base-path-auth/cache OIDC_ISSUER=http://localhost:${OIDC_PORT}/application/o/aldine/ OIDC_CLIENT_ID=aldine-e2e OIDC_CLIENT_SECRET=aldine-e2e-secret npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: AUTH_PORT,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
