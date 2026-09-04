import { defineConfig } from '@playwright/test';

/**
 * E2E suite. Assumes:
 *  - compiler service on :4020 (docker container, or locally:
 *    `DATA_DIR=$(pwd)/.data-e2e PORT=4020 node apps/compiler/server.js` —
 *    the compiler must share the app server's DATA_DIR or every compile 404s)
 *  - it starts the app server (:3100), a mock Zotero API (:4919) and Vite preview itself
 * Set ALDINE_URL to test an already-running stack (e.g. docker compose on :8080);
 * webServers are skipped via reuseExistingServer when ports are taken.
 */
// E2E_PORT / E2E_MOCK_PORT let two checkouts run this suite side by side
// (reuseExistingServer would otherwise make one run test the other's server).
const PORT = Number(process.env.E2E_PORT || 3100);
const MOCK = Number(process.env.E2E_MOCK_PORT || 4919);
const BASE = process.env.ALDINE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
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
  webServer: process.env.ALDINE_URL ? undefined : [
    {
      command: `E2E_MOCK_PORT=${MOCK} node tests/mock-zotero.mjs`,
      port: MOCK,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      // OPENROUTER_API_KEY/OPENAI_API_KEY are emptied so an ambient key can't
      // override the mock Anthropic endpoint the AI-fix test relies on.
      // VENUES_FILE points at the registry the mock server writes (it names the
      // mock's own port), so no venue test ever reaches a real publisher;
      // ALDINE_TEST_HOOKS is what makes a loopback kit URL fetchable at all.
      command: `npm run build -w apps/web && PORT=${PORT} DATA_DIR=$(pwd)/.data-e2e ALDINE_TEST_HOOKS=1 VENUES_FILE=$(pwd)/.data-e2e/venues-e2e.json OPENROUTER_API_KEY= OPENAI_API_KEY= ZOTERO_API_BASE=http://localhost:${MOCK} DOI_API_BASE=http://localhost:${MOCK} ARXIV_API_BASE=http://localhost:${MOCK} OPENALEX_API_BASE=http://localhost:${MOCK} ANTHROPIC_API_KEY=test-ai-key ANTHROPIC_BASE_URL=http://localhost:${MOCK} npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
