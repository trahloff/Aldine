import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { typeAtEnd } from '../tests/helpers';

/** '' at the root; '/internal/aldine' when the instance is served under a prefix. */
const BASE = (process.env.ALDINE_REMOTE_BASE_PATH || '').replace(/\/+$/, '');
const STAMP = Date.now();
const EMAIL = `e2e-smoke-${STAMP}@example.com`;
const PASSWORD = `smoke-${STAMP}-pw`;
const NAME = `Remote smoke ${STAMP}`;

function watch(page: Page) {
  const failed: string[] = [];
  const sockets: string[] = [];
  page.on('response', (r) => {
    // without a compiler the editor's automatic typeset answers 400; that is the skip case, not a routing miss
    if (process.env.ALDINE_REMOTE_SKIP_TYPESET && new URL(r.url()).pathname.endsWith('/compile')) return;
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on('websocket', (ws) => sockets.push(ws.url()));
  return { failed, sockets };
}

/** Sign in if the instance asks for it: register a throwaway account. */
async function signInIfNeeded(page: Page): Promise<boolean> {
  await expect(page.getByTestId('auth-email').or(page.getByTestId('new-project')).first()).toBeVisible();
  if (!(await page.getByTestId('auth-email').isVisible())) return false;
  await page.getByTestId('auth-switch').click();
  await page.getByTestId('auth-name').fill('E2E Smoke');
  await page.getByTestId('auth-email').fill(EMAIL);
  await page.getByTestId('auth-password').fill(PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('new-project')).toBeVisible();
  return true;
}

test.describe(`deployed instance${BASE ? ` under ${BASE}` : ''}`, () => {
  test('probes answer where an orchestrator looks', async ({ request }) => {
    expect((await request.get(`${BASE}/api/health`)).status()).toBe(200);
    const me = await request.get(`${BASE}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect(await me.json()).toHaveProperty('authEnabled');
    if (BASE) {
      const root = await request.get('/');
      expect(root.status()).toBe(200);
      expect(root.headers()['content-type']).toContain('text/plain');
      expect((await request.get(`${BASE}-other`)).status()).toBe(404);
      expect((await request.get('/api/projects')).status()).toBe(404);
    }
  });

  test('sign in, write, sync, typeset, share, navigate, sign out', async ({ page }) => {
    const { failed, sockets } = watch(page);
    await page.goto(`${BASE}/`);
    const authed = await signInIfNeeded(page);

    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill(NAME);
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    const m = new URL(page.url()).pathname.match(new RegExp(`^${BASE}/p/([^/]+)$`));
    expect(m, 'editor URL carries the base path').toBeTruthy();
    const projectId = m![1];
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.locator('.cm-content')).toBeVisible();

    // an edit round-trips through the collab websocket and survives a reload
    await typeAtEnd(page, '\nREMOTE-SMOKE-PERSISTED');
    await expect.poll(() => sockets.some((u) => new URL(u).pathname === `${BASE}/collab`)).toBeTruthy();
    await page.waitForTimeout(9_000);
    await page.reload();
    await expect(page.locator('.cm-content')).toContainText('REMOTE-SMOKE-PERSISTED');

    // typeset with the instance's own compiler; the PDF and its download link
    // come from under the base path. The seed document needs biblatex, which
    // a BasicTeX box lacks: ALDINE_REMOTE_SKIP_TYPESET=1 skips this block there.
    if (!process.env.ALDINE_REMOTE_SKIP_TYPESET) {
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 240_000 });
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('download-pdf')).toHaveAttribute('href', new RegExp(`^${BASE}/api/projects/${projectId}/output`));
    }

    // the share link is the public URL of this project (sharing exists only with sign-in)
    if (authed) {
      await page.getByTestId('share-project').click();
      await page.getByTestId('share-link').check();
      await expect(page.getByTestId('share-url')).toHaveText(`${page.url().split('/p/')[0]}/p/${projectId}`);
      await page.keyboard.press('Escape');
    }

    await page.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.getByTestId('project-grid')).toContainText(NAME);
    expect(new URL(page.url()).pathname).toMatch(new RegExp(`^${BASE}/?$`));

    if (authed) {
      await expect(page.getByTestId('user-name')).toBeVisible();
      await page.getByTestId('logout').click();
      await expect(page.getByTestId('auth-email')).toBeVisible();
      await page.getByTestId('auth-email').fill(EMAIL);
      await page.getByTestId('auth-password').fill(PASSWORD);
      await page.getByTestId('auth-submit').click();
      await expect(page.getByTestId('project-grid')).toContainText(NAME);
    }

    // leave the instance as we found it (best effort; the account stays)
    const del = await page.request.delete(`${BASE}/api/projects/${projectId}?permanent=1`);
    expect(del.ok()).toBeTruthy();

    expect(failed).toEqual([]);
  });
});
