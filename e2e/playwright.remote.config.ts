import { defineConfig } from '@playwright/test';

/**
 * Smoke test against a deployed instance (staging, a fresh compose stack):
 *   ALDINE_REMOTE_URL=https://staging.example.com \
 *   ALDINE_REMOTE_BASE_PATH=/internal/aldine   # only when served under a prefix
 *   npm run test:e2e:remote
 * Registers one throwaway account when the instance requires sign-in and
 * deletes the project it created. Typesetting needs the instance's compiler
 * (with biblatex); ALDINE_REMOTE_SKIP_TYPESET=1 leaves that step out.
 */
const URL = process.env.ALDINE_REMOTE_URL;
if (!URL) throw new Error('ALDINE_REMOTE_URL is required (the instance to smoke test)');

export default defineConfig({
  testDir: './remote-tests',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: URL, trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1440, height: 900 } },
});
