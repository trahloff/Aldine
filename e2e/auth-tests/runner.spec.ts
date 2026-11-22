import type { Browser, Page } from '@playwright/test';
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

/** A browser signed in as the listed runner user, its address confirmed. */
async function runnerSession(browser: Browser, ip: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
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
  // The palette entry is covered above; here the flag is set directly.
  await page.evaluate((flag) => localStorage.setItem(flag, '1'), 'aldine.experimental.runner');
  return { page, close: () => ctx.close() };
}

/** A project of the runner user with `files`, opened on its Runner panel. */
async function projectWithPanel(page: Page, name: string, files: Record<string, string> = {}): Promise<string> {
  const proj = await (await page.request.post('/api/projects', { data: { name } })).json();
  for (const [path, content] of Object.entries(files)) {
    expect((await page.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path, content } })).ok()).toBeTruthy();
  }
  await page.goto(`/p/${proj.id}`);
  await page.getByTestId('tab-runner').click();
  await expect(page.getByTestId('runner-panel')).toBeVisible();
  return proj.id;
}

/** Types `command` and presses Enter, as a person would. */
async function run(page: Page, command: string) {
  const panel = page.getByTestId('runner-panel');
  await panel.getByTestId('runner-command').fill(command);
  await panel.getByTestId('runner-command').press('Enter');
}

/** Polls the job until it leaves the queue and the runner. */
async function settled(page: Page, projectId: string, jobId: string) {
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${projectId}/runner/jobs/${jobId}`)).json()).job?.status, { timeout: 60_000 }).toMatch(/^(done|failed)$/);
}

test.describe('runner panel states', () => {
  test.skip(!!process.env.ALDINE_AUTH_URL, 'needs the dev runner the local config starts');

  test('a failing command shows its exit code and the whole log', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.73');
    const id = await projectWithPanel(page, 'Runner Failing');
    await run(page, 'mkdir -p fig && echo partial > fig/half.txt && echo to-stdout && echo to-stderr >&2 && exit 3');
    const panel = page.getByTestId('runner-panel');
    await expect(panel.getByTestId('runner-summary')).toContainText('Exited with code 3', { timeout: 30_000 });
    // A file the failed command made still comes back: the exit code does not gate the write.
    await expect(panel.getByTestId('runner-summary')).toContainText('1 file updated');
    await expect(panel.getByTestId('runner-log')).toContainText('to-stdout');
    await expect(panel.getByTestId('runner-log')).toContainText('to-stderr');
    await expect(panel.getByTestId('runner-failed')).toHaveCount(0);
    await expect(panel.getByTestId('runner-run')).toHaveText('Run');
    await expect(panel.getByTestId('runner-run')).toBeEnabled();

    // A command that cannot start says so in the log, with the shell's own words.
    await run(page, 'no-such-program-here --version');
    await expect(panel.getByTestId('runner-summary')).toContainText('Exited with code 127', { timeout: 30_000 });
    await expect(panel.getByTestId('runner-summary')).toContainText('No files changed.');
    await expect(panel.getByTestId('runner-log')).toContainText('no-such-program-here');
    expect((await page.request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent('fig/half.txt')}`)).ok()).toBeTruthy();
    await close();
  });

  test('files a run may not bring back are listed, each with its reason', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.74');
    const id = await projectWithPanel(page, 'Runner Skipped', { 'data.csv': 'x,y\n1,2\n' });
    await run(page, 'ln -s data.csv link.csv && printf x > "a:b.txt" && printf kept > kept.txt && rm data.csv && echo done');
    const panel = page.getByTestId('runner-panel');
    await expect(panel.getByTestId('runner-summary')).toContainText('Finished', { timeout: 30_000 });
    await expect(panel.getByTestId('runner-summary')).toContainText('1 file updated');
    await expect(panel.getByTestId('runner-written')).toHaveText('kept.txt');
    const skipped = panel.getByTestId('runner-skipped');
    await expect(skipped.locator('summary')).toHaveText('2 files not brought back');
    await skipped.locator('summary').click();
    await expect(skipped.locator('li')).toHaveText(['a:b.txt: name contains \\ or :', 'link.csv: symbolic links are not copied']);
    // A deletion in the run is reported, and the file stays in the project.
    await expect(panel).toContainText('1 file was deleted in the run; deletions are not brought back.');
    expect((await page.request.get(`/api/projects/${id}/file?branch=main&path=data.csv`)).ok()).toBeTruthy();
    expect((await page.request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent('a:b.txt')}`)).ok()).toBeFalsy();
    await close();
  });

  test('a command past the time limit is stopped and says so', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.75');
    await projectWithPanel(page, 'Runner Timeout');
    // playwright.auth.config.ts sets ALDINE_RUNNER_TIMEOUT_S=8.
    await run(page, 'echo started && sleep 60 && echo never');
    const panel = page.getByTestId('runner-panel');
    await expect(panel.getByTestId('runner-status')).toContainText('Running for');
    await expect(panel.getByTestId('runner-run')).toHaveText('Running…');
    await expect(panel.getByTestId('runner-run')).toBeDisabled();
    await expect(panel.getByTestId('runner-summary')).toContainText('Stopped at the time limit', { timeout: 45_000 });
    await expect(panel.getByTestId('runner-log')).toContainText('started');
    await expect(panel.getByTestId('runner-log')).not.toContainText('never');
    await close();
  });

  test('the command is remembered per project', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.76');
    const first = await projectWithPanel(page, 'Runner Memory One');
    await run(page, 'echo one');
    await expect(page.getByTestId('runner-summary')).toContainText('Finished', { timeout: 30_000 });
    await projectWithPanel(page, 'Runner Memory Two');
    await expect(page.getByTestId('runner-command')).toHaveValue('');
    await expect(page.getByTestId('runner-run')).toBeDisabled();
    await page.goto(`/p/${first}`);
    await page.getByTestId('tab-runner').click();
    await expect(page.getByTestId('runner-command')).toHaveValue('echo one');
    await close();
  });

  test('a file the run makes shows in the file tree and the next typeset uses it', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.77');
    const main = '\\documentclass{article}\n\\begin{document}\nResult: \\input{gen/value.tex}\n\\end{document}\n';
    await projectWithPanel(page, 'Runner Typeset', { 'main.tex': main });
    const tree = page.getByTestId('file-tree-rows');
    const row = (name: string) => tree.getByRole('treeitem', { name: new RegExp(`^${name.replace('.', '\\.')}\\b`) });
    await page.getByTestId('tab-files').click();
    await expect(row('main.tex')).toBeVisible();
    await expect(row('gen')).toHaveCount(0);
    await page.getByTestId('tab-runner').click();
    await run(page, 'mkdir -p gen && printf "forty-two from the runner" > gen/value.tex');
    await expect(page.getByTestId('runner-written')).toHaveText('gen/value.tex', { timeout: 30_000 });

    await page.getByTestId('tab-files').click();
    await expect(row('gen')).toBeVisible();
    if (!(await row('value.tex').isVisible())) await row('gen').click();
    await expect(row('value.tex')).toBeVisible();
    await expect(page.getByTestId('typeset-button')).toBeEnabled({ timeout: 90_000 });
    await page.getByTestId('typeset-button').click();
    await expect(page.locator('.pdf-text').first()).toContainText('forty-two from the runner', { timeout: 90_000 });
    await close();
  });

  test('a run waits in line behind another project\'s run and says where it is', async ({ browser }) => {
    const { page, close } = await runnerSession(browser, '203.0.113.78');
    const other = await (await page.request.post('/api/projects', { data: { name: 'Runner Ahead' } })).json();
    const id = await projectWithPanel(page, 'Runner Behind');
    const ahead = (await (await page.request.post(`/api/projects/${other.id}/runner/run`, { data: { branch: 'main', command: 'sleep 8' } })).json()).job;
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${other.id}/runner/jobs/${ahead.id}`)).json()).job.status).toBe('running');

    await run(page, 'echo behind');
    const panel = page.getByTestId('runner-panel');
    await expect(panel.getByTestId('runner-status')).toHaveText('Waiting for the runner (number 1 in line)…');
    await expect(panel.getByTestId('runner-run')).toBeDisabled();
    await expect(panel.getByTestId('runner-summary')).toContainText('Finished', { timeout: 60_000 });
    await expect(panel.getByTestId('runner-log')).toHaveText('behind\n');

    // A second run of the same project while one waits or runs is refused, and the panel says why.
    const again = (await (await page.request.post(`/api/projects/${id}/runner/run`, { data: { branch: 'main', command: 'sleep 3' } })).json()).job;
    await run(page, 'echo too-soon');
    await expect(panel.getByTestId('runner-error')).toHaveText('A run of this project is already waiting or running');
    await settled(page, id, again.id);
    await settled(page, other.id, ahead.id);
    await close();
  });
});
