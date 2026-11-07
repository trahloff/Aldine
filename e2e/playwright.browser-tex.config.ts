import { defineConfig } from '@playwright/test';

/**
 * Typesetting in the browser (ALDINE_TYPESET=browser): no compiler, the
 * app server hands out TeX Live as WebAssembly and fetches the packages its
 * profile lacks from a TeX Live mirror. The smallest profile keeps the
 * download short and makes every spec that uses TikZ exercise on-demand
 * packages. BROWSER_TEX_DIR names a directory the build was already fetched
 * into (node apps/server/dist/browsertex/fetch.js --into <dir> --profile
 * basic) so a run downloads nothing; without it the server fetches the
 * build into the suite's cache at boot (about 160 MB). A second server with
 * accounts on (E2E_BROWSER_TEX_AUTH_PORT) runs browser-tex-auth.spec.ts; it
 * serves the web build the first one made, so it must stay after that one.
 *   npm run test:e2e:browser-tex
 */
const PORT = Number(process.env.E2E_BROWSER_TEX_PORT || 3410);
const BASE = process.env.ALDINE_BROWSER_TEX_URL || `http://localhost:${PORT}`;
const AUTH_PORT = Number(process.env.E2E_BROWSER_TEX_AUTH_PORT || 3411);
const BAKED = process.env.BROWSER_TEX_DIR ? `ALDINE_BROWSER_TEX_DIR=${process.env.BROWSER_TEX_DIR}` : '';

export default defineConfig({
  testDir: './browser-tex-tests',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: process.env.ALDINE_BROWSER_TEX_URL ? undefined : [
    {
      command: `npm run build -w apps/web && PORT=${PORT} ALDINE_TYPESET=browser ALDINE_BROWSER_TEX_PROFILE=basic ALDINE_BROWSER_CLAIM_MS=3000 ${BAKED} COMPILER_URL=http://127.0.0.1:9 DATA_DIR=$(pwd)/.data-browser-tex META_DIR=$(pwd)/.secrets-browser-tex CACHE_DIR=$(pwd)/.data-browser-tex/cache npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: PORT,
      reuseExistingServer: true,
      timeout: 900_000,
    },
    {
      command: `PORT=${AUTH_PORT} AUTH_ENABLED=1 ALDINE_TYPESET=browser ALDINE_BROWSER_TEX_PROFILE=basic ${BAKED} COMPILER_URL=http://127.0.0.1:9 DATA_DIR=$(pwd)/.data-browser-tex-auth META_DIR=$(pwd)/.secrets-browser-tex-auth CACHE_DIR=$(pwd)/.data-browser-tex/cache npx tsx apps/server/src/index.ts`,
      cwd: '..',
      port: AUTH_PORT,
      reuseExistingServer: true,
      timeout: 900_000,
    },
  ],
});
