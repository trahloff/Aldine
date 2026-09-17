import { defineConfig } from '@playwright/test';

/**
 * GitLab auto-provisioning (#51 Stage B) runs against its own app server: the
 * main suite's server has no GITLAB_DEFAULT_GROUP, and provisioning changes
 * what "Create project" does (every new project also lands on GitLab), which
 * would leak into every other spec. The mock GitLab is the main suite's
 * tests/mock-gitlab.mjs on a second port; its bare repos still live under
 * .data-e2e-gitlab, so run this suite and `test:e2e` one after the other.
 *   compiler: DATA_DIR=$(pwd)/.data-e2e-prov PORT=4020 node apps/compiler/server.js
 *             (or COMPILER_URL=...; no test here typesets)
 */
const PORT = Number(process.env.E2E_PROV_PORT || 3300);
const GITLAB = Number(process.env.E2E_PROV_GITLAB_PORT || 4925);
const COMPILER = process.env.COMPILER_URL || 'http://localhost:4020';
const BASE = process.env.ALDINE_PROV_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: /34-provisioning\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.ALDINE_PROV_URL ? undefined : [
    {
      command: `E2E_GITLAB_PORT=${GITLAB} node tests/mock-gitlab.mjs`,
      port: GITLAB,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      // GITLAB_TOKEN + GITLAB_DEFAULT_GROUP switch provisioning on; the mock
      // accepts any bearer token. AUTOPUSH_DEBOUNCE_MS is short so the
      // autopush test can watch a push land instead of waiting 30 s.
      command: `npm run build -w apps/web && PORT=${PORT} DATA_DIR=$(pwd)/.data-e2e-prov META_DIR=$(pwd)/.secrets-e2e-prov ALDINE_TEST_HOOKS=1 GITLAB_API_BASE=http://localhost:${GITLAB} GITLAB_TOKEN=service-token GITLAB_DEFAULT_GROUP=research/latex AUTOPUSH_DEBOUNCE_MS=400 COMPILER_URL=${COMPILER} OPENROUTER_API_KEY= OPENAI_API_KEY= npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
