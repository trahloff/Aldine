import fs from 'node:fs';
import { test, expect } from '../fixtures';
import { unzip } from '../../apps/server/src/unzip';

/**
 * #125: Export your data and Delete account, in Account settings. The export
 * is one download with account.json and each owned project's branches as
 * the Share dialog's ZIP; deleting asks for the address, names the projects
 * other people lose, removes the account and lands on the sign-in page.
 */
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

test('a person exports their data and deletes their own account (#125)', async ({ browser }) => {
  // its own client address keeps it off the sign-in limit the suite shares
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.125' } });
  const page = await ctx.newPage();
  const email = uniq();
  await page.goto('/');
  await page.getByTestId('auth-switch').click();
  await page.getByTestId('auth-name').fill('Ada Export');
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill('password123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

  const proj = await (await page.request.post('/api/projects', { data: { name: 'Exported Paper' } })).json();
  expect((await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'notes.tex', content: 'EXPORT-MARKER\n' } })).ok()).toBeTruthy();
  const share = await page.request.post(`/api/projects/${proj.id}/invitations`, { data: { to: 'coauthor@example.org' } });
  expect(share.ok()).toBeTruthy();

  await page.getByTestId('account-menu').click();
  await page.getByTestId('user-name').click();
  const settings = page.getByTestId('account-settings');
  const exportLink = settings.getByTestId('account-export');
  await exportLink.scrollIntoViewIfNeeded();
  const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
  expect(download.suggestedFilename()).toMatch(/^aldine-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzip(fs.readFileSync((await download.path())!));
  const account = JSON.parse(files['account.json'].toString('utf8'));
  expect(account.account.email).toBe(email);
  expect(account.account.name).toBe('Ada Export');
  const row = account.ownedProjects.find((p: { id: string }) => p.id === proj.id);
  expect(row.name).toBe('Exported Paper');
  expect(unzip(files[row.branches.main])['notes.tex'].toString('utf8')).toBe('EXPORT-MARKER\n');

  await settings.getByTestId('account-delete').click();
  const dialog = page.getByTestId('account-delete-dialog');
  await expect(dialog.getByTestId('account-delete-projects')).toContainText('Your 1 project is deleted for good');
  await expect(dialog.getByTestId(`account-delete-shared-${proj.id}`)).toContainText('Exported Paper');
  await expect(dialog.getByTestId(`account-delete-shared-${proj.id}`)).toContainText('1 other person');
  const submit = dialog.getByTestId('account-delete-submit');
  await expect(submit).toBeDisabled();
  await dialog.getByTestId('account-delete-confirm-input').fill('not my address');
  await expect(submit).toBeDisabled();
  await dialog.getByTestId('account-delete-confirm-input').fill(email.toUpperCase());
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByTestId('auth-info')).toHaveText('Your account is deleted, together with the projects you owned.');
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  expect((await page.request.get(`/api/projects/${proj.id}`)).status()).toBe(404);
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill('password123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('Incorrect email or password');
  await ctx.close();
});
