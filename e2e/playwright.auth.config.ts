import { defineConfig } from '@playwright/test';

/** Auth-enabled stack on :3200, isolated from the main (no-auth) suite. A
 *  stub of orcid.org on :4929 backs the ORCID sign-in tests and a mock
 *  OpenID Connect provider on :4930 (Authentik-shaped issuer with a path) the
 *  OIDC ones, restricted to the `aldine-users` group; Google and GitHub stay
 *  unconfigured on purpose. Ports: E2E_AUTH_PORT, E2E_AUTH_MOCK_PORT and
 *  E2E_AUTH_OIDC_PORT; a second checkout must override all three, or it
 *  reuses this one's mocks. */
const PORT = Number(process.env.E2E_AUTH_PORT || 3200);
const MOCK = Number(process.env.E2E_AUTH_MOCK_PORT || 4929);
const OIDC = Number(process.env.E2E_AUTH_OIDC_PORT || 4930);
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
      command: `E2E_AUTH_OIDC_PORT=${OIDC} node auth-tests/mock-oidc.mjs`,
      port: OIDC,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `npm run build -w apps/web && PORT=${PORT} AUTH_ENABLED=1 ALDINE_MCP=1 ALDINE_ADMIN_EMAILS=admin@test.com ALDINE_RESET_ECHO=1 ALDINE_TEST_HOOKS=1 TRUST_PROXY=1 RL_REGISTER_BURST=200 RL_MCP_BURST=1000 DATA_DIR=$(pwd)/.data-auth META_DIR=$(pwd)/.secrets-auth ORCID_CLIENT_ID=test-orcid ORCID_CLIENT_SECRET=test-orcid-secret ORCID_API_BASE=http://localhost:${MOCK} ORCID_PUB_API_BASE=http://localhost:${MOCK} OIDC_ISSUER=http://localhost:${OIDC}/application/o/aldine/ OIDC_CLIENT_ID=aldine-e2e OIDC_CLIENT_SECRET=aldine-e2e-secret OIDC_ALLOWED_GROUPS=aldine-users npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
