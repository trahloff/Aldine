import { test, expect } from '../fixtures';

/**
 * The runner, an experimental preview (docs/RUNNER.md): a listed person turns
 * the panel on from the command palette, runs a command, and its new file
 * lands in the project. playwright.auth.config.ts
 * starts apps/runner/server.js in its insecure dev mode next to the app (no
 * container); the container's own settings are covered by the release smoke.
 */
const RUNNER_USER = 'runner-e2e@test.com';

test('a listed person runs a command from the Runner panel and gets its file back', async ({ browser }) => {
  test.skip(!!process.env.ALDINE_AUTH_URL, 'needs the dev runner the local config starts');
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.71' } });
  const page = await ctx.newPage();
  await page.goto('/');
  const reg = await page.request.post('/api/auth/register', { data: { email: RUNNER_USER, password: 'password123', name: 'Rosalind Runner' } });
  if (!reg.ok()) expect((await page.request.post('/api/auth/login', { data: { email: RUNNER_USER, password: 'password123' } })).ok()).toBeTruthy();
  const me = await (await page.request.get('/api/auth/me')).json();
  if (me.user.emailPending) {
    const { link } = await (await page.request.get(`/api/test/confirmation-link?email=${encodeURIComponent(RUNNER_USER)}`)).json();
    const token = new URL(link, 'http://x').searchParams.get('confirm_email');
    expect((await page.request.post('/api/auth/confirm-email', { data: { token } })).ok()).toBeTruthy();
  }
  expect((await (await page.request.get('/api/auth/me')).json()).runner).toBe(true);

  const proj = await (await page.request.post('/api/projects', { data: { name: 'Runner Paper' } })).json();
  expect((await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n' } })).ok()).toBeTruthy();
  await page.goto(`/p/${proj.id}`);
  await expect(page.getByTestId('tab-runner')).toHaveCount(0);

  await page.getByTestId('palette-open').click();
  await page.getByTestId('palette-input').fill('experimental runner');
  await page.getByTestId('palette-item-experimental-runner').click();
  await page.getByTestId('tab-runner').click();
  const panel = page.getByTestId('runner-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('runner-command').fill('mkdir -p fig && printf "made by a run\\n" > fig/out.txt && echo figure-done');
  await panel.getByTestId('runner-run').click();
  await expect(panel.getByTestId('runner-summary')).toContainText('Finished', { timeout: 30_000 });
  await expect(panel.getByTestId('runner-summary')).toContainText('1 file updated');
  await expect(panel.getByTestId('runner-written')).toHaveText('fig/out.txt');
  await expect(panel.getByTestId('runner-log')).toContainText('figure-done');

  const file = await (await page.request.get(`/api/projects/${proj.id}/file?branch=main&path=${encodeURIComponent('fig/out.txt')}`)).text();
  expect(file).toContain('made by a run');

  // The command is remembered for the next run of this project.
  await page.reload();
  await page.getByTestId('tab-runner').click();
  await expect(page.getByTestId('runner-command')).toHaveValue('mkdir -p fig && printf "made by a run\\n" > fig/out.txt && echo figure-done');
  await ctx.close();
});

test('someone not on ALDINE_RUNNER_USERS is not offered the runner and cannot start a run', async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.72' } });
  const page = await ctx.newPage();
  await page.goto('/');
  const email = `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: 'Nora' } })).ok()).toBeTruthy();
  expect((await (await page.request.get('/api/auth/me')).json()).runner).toBe(false);
  const proj = await (await page.request.post('/api/projects', { data: { name: 'No Runner' } })).json();
  const res = await page.request.post(`/api/projects/${proj.id}/runner/run`, { data: { branch: 'main', command: 'true' } });
  expect(res.status()).toBe(403);
  await page.goto(`/p/${proj.id}`);
  await page.getByTestId('palette-open').click();
  await page.getByTestId('palette-input').fill('experimental runner');
  await expect(page.getByTestId('palette-item-experimental-runner')).toHaveCount(0);
  await ctx.close();
});
