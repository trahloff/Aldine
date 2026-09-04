import { defineConfig } from '@playwright/test';

/**
 * E2E suite. Assumes:
 *  - compiler service on :4020 (docker container, or locally:
 *    `DATA_DIR=$(pwd)/.data-e2e PORT=4020 node apps/compiler/server.js` —
 *    the compiler must share the app server's DATA_DIR or every compile 404s)
 *  - it starts the app server (:3100), a mock Zotero API (:4919), a mock GitLab
 *    API (:4921) and Vite preview itself
 * Set ALDINE_URL to test an already-running stack (e.g. docker compose on :8080);
 * webServers are skipped via reuseExistingServer when ports are taken.
 */
const BASE = process.env.ALDINE_URL || 'http://localhost:3100';
/**
 * A second app server with GitLab auto-provisioning switched on. It is separate
 * so the main suite keeps proving that project creation is untouched when the
 * feature is off — which is the default for every deployment.
 */
const PROVISION_BASE = 'http://localhost:3101';

export default defineConfig({
  testDir: './tests',
  projects: [
    { name: 'app', testIgnore: '**/15-provisioning.spec.ts' },
    { name: 'provisioning', testMatch: '**/15-provisioning.spec.ts', use: { baseURL: PROVISION_BASE } },
  ],
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
      command: 'node tests/mock-gitlab.mjs',
      port: 4921,
      reuseExistingServer: true,
      timeout: 20_000,
    },
    {
      // Auto-provisioning enabled, on its own data dir so it never races the
      // main server over project metadata. It builds the web app too: both
      // servers serve the same dist, and running only --project=provisioning
      // would otherwise serve a stale bundle.
      command: 'npm run build -w apps/web && PORT=3101 DATA_DIR=$(pwd)/.data-e2e-prov META_DIR=$(pwd)/.secrets-e2e-prov GITLAB_API_BASE=http://localhost:4921/api/v4 GITLAB_TOKEN=e2e-service-token GITLAB_DEFAULT_GROUP=research/latex GITLAB_TEMPLATE_GROUP=research/latex/templates GITLAB_TEMPLATE_TTL_MS=1000 AUTOPUSH_DEBOUNCE_MS=400 npx tsx apps/server/src/index.ts',
      cwd: '..',
      port: 3101,
      reuseExistingServer: true,
      timeout: 600_000,
    },
    {
      // OPENROUTER_API_KEY/OPENAI_API_KEY are emptied so an ambient key can't
      // override the mock Anthropic endpoint the AI-fix test relies on.
      command: 'npm run build -w apps/web && PORT=3100 DATA_DIR=$(pwd)/.data-e2e META_DIR=$(pwd)/.secrets-e2e OPENROUTER_API_KEY= OPENAI_API_KEY= GITLAB_API_BASE=http://localhost:4921/api/v4 ZOTERO_API_BASE=http://localhost:4919 DOI_API_BASE=http://localhost:4919 ARXIV_API_BASE=http://localhost:4919 OPENALEX_API_BASE=http://localhost:4919 ANTHROPIC_API_KEY=test-ai-key ANTHROPIC_BASE_URL=http://localhost:4919 npx tsx apps/server/src/index.ts',
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
