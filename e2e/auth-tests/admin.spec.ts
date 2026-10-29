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
  if (reg.ok()) {
    // The admin list ignores an address until it is confirmed (ALDINE_TEST_HOOKS hands over the logged link).
    const { link } = await (await page.request.get(`/api/test/confirmation-link?email=${encodeURIComponent(email)}`)).json();
    const token = new URL(link, 'http://x').searchParams.get('confirm_email');
    expect((await page.request.post('/api/auth/confirm-email', { data: { token } })).ok()).toBeTruthy();
  } else {
    const login = await page.request.post('/api/auth/login', { data: { email, password: 'password123' } });
    expect(login.ok()).toBeTruthy();
  }
  await page.goto('/');
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
}

test.describe('server admin', () => {
  test('a regular account gets no link, no page, and 403 from the API', async ({ page }) => {
    await signIn(page, uniq('plain'), 'Plain');
    await expect(page.getByTestId('account-menu')).toBeVisible();
    await page.getByTestId('account-menu').click();
    await expect(page.getByTestId('user-name')).toBeVisible();
    await expect(page.getByTestId('admin-link')).toHaveCount(0);
    await page.keyboard.press('Escape');

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
    await page.getByTestId('account-menu').click();
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

/** A browser of its own, signing in from its own address: the auth suite
 *  shares one per-address sign-in budget (RL_LOGIN_BURST), and these tests
 *  sign in often. TRUST_PROXY=1 on this stack makes the header count. */
async function ownBrowser(browser: import('@playwright/test').Browser) {
  const addr = `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
  return (await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': addr } })).newPage();
}

test.describe('account actions on the admin page', () => {
  test('disable signs the account out and keeps it out; enable lets it back in', async ({ browser }) => {
    const victimEmail = uniq('victim');
    const victim = await ownBrowser(browser);
    await signIn(victim, victimEmail, 'Victim');

    const page = await ownBrowser(browser);
    await signIn(page, ADMIN_EMAIL, 'Admin');
    await page.goto('/admin');
    const row = page.getByTestId('admin-user-row').filter({ hasText: victimEmail });
    await expect(row.getByTestId('admin-status-active')).toBeVisible();
    await row.getByTestId('admin-manage').click();
    await page.getByTestId('admin-disable').click();
    await expect(page.getByTestId('admin-action-message')).toContainText('signed out everywhere');
    await page.getByTestId('admin-action-confirm').click();
    await expect(page.getByTestId('admin-account-status')).toContainText('Disabled since');
    await page.getByTestId('admin-account-close').click();
    await expect(row.getByTestId('admin-status-disabled')).toBeVisible();

    // The victim's next request is signed out, and signing in again fails.
    expect((await victim.request.get('/api/projects')).status()).toBe(401);
    await victim.reload();
    await expect(victim.getByTestId('auth-email')).toBeVisible();
    await victim.getByTestId('auth-email').fill(victimEmail);
    await victim.getByTestId('auth-password').fill('password123');
    await victim.getByTestId('auth-submit').click();
    await expect(victim.getByTestId('auth-error')).toContainText('This account is disabled');

    await row.getByTestId('admin-manage').click();
    await page.getByTestId('admin-enable').click();
    await page.getByTestId('admin-action-confirm').click();
    await expect(page.getByTestId('admin-account-status')).toHaveText('Active');
    await page.getByTestId('admin-account-close').click();
    await expect(row.getByTestId('admin-status-active')).toBeVisible();

    await victim.getByTestId('auth-submit').click();
    await expect(victim.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
    await victim.context().close();
    await page.context().close();
  });

  test('the admin cannot disable or delete their own account', async ({ browser }) => {
    const page = await ownBrowser(browser);
    await signIn(page, ADMIN_EMAIL, 'Admin');
    await page.goto('/admin');
    await page.getByTestId('admin-user-row').filter({ hasText: ADMIN_EMAIL }).getByTestId('admin-manage').click();
    await expect(page.getByTestId('admin-disable')).toBeDisabled();
    await expect(page.getByTestId('admin-delete')).toBeDisabled();
    await expect(page.getByTestId('admin-account-dialog')).toContainText('You cannot disable or delete your own account.');
    await page.context().close();
  });

  test('confirm an address by hand, and hand out a reset link', async ({ browser }) => {
    const email = uniq('pending');
    const other = (await ownBrowser(browser)).context();
    expect((await other.request.post('/api/auth/register', { data: { email, password: 'password123', name: 'Pending' } })).ok()).toBeTruthy();

    const page = await ownBrowser(browser);
    await signIn(page, ADMIN_EMAIL, 'Admin');
    await page.goto('/admin');
    const row = page.getByTestId('admin-user-row').filter({ hasText: email });
    await expect(row.getByTestId('admin-email-pending')).toBeVisible();
    await row.getByTestId('admin-manage').click();
    await page.getByTestId('admin-confirm-email').click();
    await page.getByTestId('admin-action-confirm').click();
    await expect(page.getByTestId('admin-confirm-email')).toHaveCount(0);
    expect((await (await other.request.get('/api/auth/me')).json()).user.emailPending).toBeUndefined();

    // This stack sends no email: the link comes back to the administrator.
    await page.getByTestId('admin-reset-link').click();
    await expect(page.getByTestId('admin-action-message')).toContainText('sends no email');
    await page.getByTestId('admin-action-confirm').click();
    const link = await page.getByTestId('admin-reset-link-value').inputValue();
    const token = new URL(link).searchParams.get('reset_token');
    expect(token).toBeTruthy();
    expect((await other.request.post('/api/auth/reset', { data: { token, newPassword: 'reset-by-admin' } })).ok()).toBeTruthy();
    expect((await other.request.post('/api/auth/login', { data: { email, password: 'reset-by-admin' } })).ok()).toBeTruthy();
    await other.close();
    await page.context().close();
  });

  test('delete an account and give its projects to another', async ({ browser }) => {
    const ownerEmail = uniq('leaving');
    const heirEmail = uniq('heir');
    const owner = (await ownBrowser(browser)).context();
    expect((await owner.request.post('/api/auth/register', { data: { email: ownerEmail, password: 'password123', name: 'Leaving' } })).ok()).toBeTruthy();
    const name = `Handover ${Date.now()}`;
    expect((await owner.request.post('/api/projects', { data: { name } })).ok()).toBeTruthy();
    const heir = await ownBrowser(browser);
    await signIn(heir, heirEmail, 'Heir');

    const page = await ownBrowser(browser);
    await signIn(page, ADMIN_EMAIL, 'Admin');
    await page.goto('/admin');
    await page.getByTestId('admin-user-row').filter({ hasText: ownerEmail }).getByTestId('admin-manage').click();
    await page.getByTestId('admin-delete').click();
    await expect(page.getByTestId('admin-delete-submit')).toBeDisabled();
    await page.getByTestId('admin-delete-transfer').check();
    await page.getByTestId('admin-delete-transfer-to').selectOption({ label: `Heir — ${heirEmail}` });
    await page.getByTestId('admin-delete-confirm-input').fill('not the address');
    await expect(page.getByTestId('admin-delete-submit')).toBeDisabled();
    await page.getByTestId('admin-delete-confirm-input').fill(ownerEmail);
    await page.getByTestId('admin-delete-submit').click();
    await expect(page.getByTestId('admin-notice')).toHaveText(`Deleted ${ownerEmail}. ${heirEmail} now owns 1 project.`);
    await expect(page.getByTestId('admin-user-row').filter({ hasText: ownerEmail })).toHaveCount(0);

    expect((await owner.request.get('/api/projects')).status()).toBe(401);
    await heir.goto('/');
    await expect(heir.getByTestId('project-grid')).toContainText(name, { timeout: 15_000 });
    await owner.close();
    await heir.context().close();
    await page.context().close();
  });
});
