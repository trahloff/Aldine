import { test, expect } from '../fixtures';

/** Unique email per run so re-runs don't collide with the persisted user store. */
const uniq = (tag: string) => `${tag}${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

/** The auth stack is started with ALDINE_ADMIN_EMAILS=admin@test.com (see
 *  playwright.auth.config.ts); a re-run finds that account already registered. */
const ADMIN_EMAIL = 'admin@test.com';

/** Register (first run) or sign in (re-run against the persisted store); the
 *  page shares the request context's cookie jar, so the UI is signed in after. */
async function signIn(page: import('@playwright/test').Page, email: string, name: string) {
  const reg = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name } });
  if (!reg.ok()) {
    const login = await page.request.post('/api/auth/login', { data: { email, password: 'password123' } });
    expect(login.ok()).toBeTruthy();
  }
  await page.goto('/');
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
}

test.describe('server admin', () => {
  test('a regular account gets no link, no page, and 403 from the API', async ({ page }) => {
    await signIn(page, uniq('plain'), 'Plain');
    await expect(page.getByTestId('user-name')).toBeVisible();
    await expect(page.getByTestId('admin-link')).toHaveCount(0);

    const denied = await page.request.get('/api/admin/stats');
    expect(denied.status()).toBe(403);

    await page.goto('/admin');
    await expect(page.getByTestId('admin-denied')).toBeVisible();
    await expect(page.getByTestId('admin-page')).toHaveCount(0);
  });

  test('the allow-listed account sees counts and the accounts table', async ({ page, browser }) => {
    // One more account guarantees the table has somebody besides the admin.
    const other = await browser.newContext();
    const otherEmail = uniq('other');
    await other.request.post('/api/auth/register', { data: { email: otherEmail, password: 'password123', name: 'Other' } });
    await other.request.post('/api/projects', { data: { name: 'Counted' } });
    await other.close();

    await signIn(page, ADMIN_EMAIL, 'Admin');
    await page.getByTestId('admin-link').click();
    await expect(page.getByTestId('admin-page')).toBeVisible();

    const total = Number(await page.getByTestId('stat-users-total').locator('.admin__stat-value').textContent());
    expect(total).toBeGreaterThanOrEqual(2);
    const active = Number(await page.getByTestId('stat-users-active7d').locator('.admin__stat-value').textContent());
    expect(active).toBeGreaterThanOrEqual(2);
    expect(active).toBeLessThanOrEqual(total);

    const rows = page.getByTestId('admin-user-row');
    await expect(rows.filter({ hasText: otherEmail })).toHaveCount(1);
    await expect(rows.filter({ hasText: otherEmail })).toContainText('1'); // owns one project
    await expect(rows.filter({ hasText: ADMIN_EMAIL })).toContainText('admin');

    const stats = await (await page.request.get('/api/admin/stats')).json();
    expect(stats.admins).toEqual([ADMIN_EMAIL]);
    expect(stats.users.total).toBe(total);
  });
});
