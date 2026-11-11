import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../fixtures';

/**
 * Commit email (#294): set in Account settings, it is the author address of
 * the commits Aldine makes for the account; the author name stays the
 * account name. The repository is read on disk (.data-auth, the DATA_DIR of
 * playwright.auth.config.ts): no route shows an author's email.
 */
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;
const projectsDir = path.resolve(__dirname, '..', '..', '.data-auth', 'projects');
const headIdent = (projectId: string) =>
  execFileSync('git', ['log', '-1', '--format=%an <%ae>|%s', 'main'], { cwd: path.join(projectsDir, projectId), encoding: 'utf8' }).trim();

test('the commit email from Account settings is the author email of a checkpoint (#294)', async ({ browser }) => {
  test.skip(!!process.env.ALDINE_AUTH_URL, 'reads the repository on the local DATA_DIR');
  // its own client address keeps it off the sign-in limit the suite shares
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.94' } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('auth-switch').click();
  await page.getByTestId('auth-name').fill('Grace Hopper');
  await page.getByTestId('auth-email').fill(uniq());
  await page.getByTestId('auth-password').fill('password123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('account-menu').click();
  await page.getByTestId('user-name').click();
  const settings = page.getByTestId('account-settings');
  await expect(settings.getByTestId('account-commit-email')).toHaveText('Not set');
  await settings.getByTestId('account-commit-email-edit').click();
  await settings.getByTestId('account-commit-email-input').fill('grace hopper@example.org');
  await settings.getByTestId('account-commit-email-save').click();
  await expect(settings.getByTestId('account-commit-email-error')).toHaveText('Enter an email address like name@example.com');
  const noreply = '1234+grace@users.noreply.github.com';
  await settings.getByTestId('account-commit-email-input').fill(`  ${noreply} `);
  await settings.getByTestId('account-commit-email-input').press('Enter');
  await expect(page.locator('.toast', { hasText: `Your commits now use ${noreply}` })).toBeVisible();
  await expect(settings.getByTestId('account-commit-email')).toHaveText(noreply);
  await page.keyboard.press('Escape');
  expect((await (await page.request.get('/api/auth/me')).json()).user.commitEmail).toBe(noreply);

  const proj = await (await page.request.post('/api/projects', { data: { name: 'Commit Email Paper' } })).json();
  expect((await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'notes.tex', content: 'First note.\n' } })).ok()).toBeTruthy();
  const saved = await (await page.request.post(`/api/projects/${proj.id}/commit`, { data: { branch: 'main', message: 'Add notes' } })).json();
  expect(saved.committed).toBe(true);
  expect(headIdent(proj.id)).toBe(`Grace Hopper <${noreply}>|Add notes`);
  // History still groups by the name
  const log = await (await page.request.get(`/api/projects/${proj.id}/log?branch=main`)).json();
  expect(log[0].author).toBe('Grace Hopper');
  expect(JSON.stringify(log)).not.toContain(noreply);
  // the project as others load it does not carry the address
  expect(JSON.stringify(await (await page.request.get(`/api/projects/${proj.id}`)).json())).not.toContain(noreply);

  // cleared, commits go back to the derived address
  expect((await page.request.patch('/api/auth/me', { data: { commitEmail: '' } })).ok()).toBeTruthy();
  expect((await (await page.request.get('/api/auth/me')).json()).user.commitEmail).toBeUndefined();
  await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'notes.tex', content: 'Second note.\n' } });
  await page.request.post(`/api/projects/${proj.id}/commit`, { data: { branch: 'main', message: 'Edit notes' } });
  expect(headIdent(proj.id)).toBe('Grace Hopper <grace.hopper@aldine.local>|Edit notes');

  // an access token is the agent's, not the person: it cannot set the address
  const { token } = await (await page.request.post('/api/tokens', { data: { name: 'agent' } })).json();
  const viaToken = await page.request.fetch('/api/auth/me', { method: 'PATCH', headers: { authorization: `Bearer ${token}`, cookie: '' }, data: { commitEmail: 'mallory@example.org' } });
  expect(viaToken.status()).toBe(403);

  await page.request.delete(`/api/projects/${proj.id}?permanent=1`);
  await ctx.close();
});
