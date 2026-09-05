import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { typeAtEnd } from '../tests/helpers';

/** Mirrors ALDINE_BASE_PATH in playwright.base-path.config.ts. */
const BASE = '/internal/aldine';

/** Every response ≥ 400 and every websocket the page opens, for the assertions
 *  below. Typeset results are skipped: this suite runs without a compiler, and
 *  a 400 from <base>/api/…/compile is the compiler's absence, not a routing miss. */
function watch(page: Page) {
  const failed: string[] = [];
  const sockets: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && !new URL(r.url()).pathname.endsWith('/compile')) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on('websocket', (ws) => sockets.push(ws.url()));
  return { failed, sockets };
}

test.describe('served under a base path (#27)', () => {
  test('only the base path is ours; the health check also answers at the root', async ({ request }) => {
    expect((await request.get('/')).status()).toBe(404);
    expect((await request.get('/api/projects')).status()).toBe(404);
    expect((await request.get(`${BASE}-other`)).status()).toBe(404);
    expect((await request.get(`${BASE}/api/projects`)).status()).toBe(200);
    expect((await request.get(`${BASE}/api/health`)).status()).toBe(200);
    // compose healthchecks poll the container's own root, whatever the prefix
    expect((await request.get('/api/health')).status()).toBe(200);
  });

  test('home, project creation, editor, live sync and navigation all work under the prefix', async ({ page }) => {
    const { failed, sockets } = watch(page);

    await page.goto(BASE); // no trailing slash, as a portal link would be typed
    await expect(page.locator('.home__brand').first()).toContainText('aldine');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Sub-path paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(new RegExp(`^${BASE}/p/[^/]+$`));
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    await expect(page.locator('.cm-content')).toBeVisible();

    // an edit round-trips through the collab websocket at <base>/collab
    await typeAtEnd(page, '\nBASE-PATH-PERSISTED');
    await expect.poll(() => sockets.some((u) => new URL(u).pathname === `${BASE}/collab`)).toBeTruthy();
    await page.waitForTimeout(9_000); // hocuspocus debounce before it hits disk
    await page.reload();
    await expect(page.locator('.cm-content')).toContainText('BASE-PATH-PERSISTED', { timeout: 15_000 });

    // in-app navigation keeps the prefix
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.getByTestId('project-grid')).toContainText('Sub-path paper');
    expect(new URL(page.url()).pathname).toMatch(new RegExp(`^${BASE}/?$`));

    expect(failed).toEqual([]);
  });

  test('a deep link reloads straight into the editor', async ({ page, request }) => {
    const { failed } = watch(page);
    const res = await request.post(`${BASE}/api/projects`, { data: { name: 'Deep link' } });
    expect(res.ok()).toBeTruthy();
    const { id } = await res.json();
    await page.goto(`${BASE}/p/${id}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('project-name')).toContainText('Deep link');
    expect(failed).toEqual([]);
  });
});
