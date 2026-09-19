import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * GitLab as a second remote provider (Stage A) and Gitea/Forgejo as a third.
 * The app server talks to tests/mock-gitlab.mjs (GITLAB_API_BASE) and
 * tests/mock-gitea.mjs (GITEA_API_BASE), whose projects are real bare repos
 * under .data-e2e-gitlab and .data-e2e-gitea, so clone/push/pull run against
 * actual git. The connection lives server-side (META_DIR=.secrets-e2e), so it
 * carries across tests and runs: every test that needs a state establishes
 * it itself.
 */
const GITLAB = Number(process.env.E2E_GITLAB_PORT || 4921);
const MOCK = `http://localhost:${GITLAB}`;
const AUTH = { authorization: 'Bearer x' };
const GITLAB_DATA = path.resolve(__dirname, '../../.data-e2e-gitlab');
const BARE = path.join(GITLAB_DATA, 'grp/sub/paper.git');
const GITEA = Number(process.env.E2E_GITEA_PORT || 4923);
const GITEA_MOCK = `http://localhost:${GITEA}`;
const GITEA_DATA = path.resolve(__dirname, '../../.data-e2e-gitea');
const GITEA_BARE = path.join(GITEA_DATA, 'e2e-user/paper.git');

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Connect the mock with a PAT, disconnecting first when a previous run left a connection behind. */
async function connectWithToken(page: Page, token = 'e2e-token') {
  const disconnect = page.getByTestId('gitlab-disconnect');
  const tokenInput = page.getByTestId('gitlab-token');
  await expect(disconnect.or(tokenInput)).toBeVisible();
  if (await disconnect.isVisible()) {
    await disconnect.click();
    await expect(tokenInput).toBeVisible();
  }
  await tokenInput.fill(token);
  await page.getByTestId('gitlab-connect').click();
}

async function openFile(page: Page, name: string) {
  await expect(page.getByTestId(`file-${name}`)).toBeVisible();
  await page.getByTestId(`file-${name}`).click();
}

test.describe('remote providers on Home', () => {
  test('Home offers all three git hosts', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('new-from-github')).toBeVisible();
    await expect(page.getByTestId('new-from-gitlab')).toBeVisible();
    await expect(page.getByTestId('new-from-gitea')).toHaveText('From Gitea / Forgejo');
  });

  test('first-run onboarding offers all three git hosts', async ({ browser }) => {
    const ctx = await browser.newContext(); // raw context → no pre-dismiss, fresh localStorage
    const p = await ctx.newPage();
    try {
      await p.goto('/');
      await expect(p.getByTestId('onboarding')).toBeVisible({ timeout: 10_000 });
      await expect(p.getByTestId('onboard-github')).toBeVisible();
      await expect(p.getByTestId('onboard-gitlab')).toBeVisible();
      await expect(p.getByTestId('onboard-gitea')).toContainText('Import from Gitea / Forgejo');
    } finally { await ctx.close(); }
  });

  test('/api/remotes lists all three providers with their labels', async ({ request }) => {
    const res = await request.get('/api/remotes');
    expect(res.ok()).toBeTruthy();
    const list: { id: string; label: string; changeRequestLabel: string; selfHosted: boolean; baseUrlRequired: boolean; oauth: boolean }[] = await res.json();
    expect(list.map((r) => r.id).sort()).toEqual(['gitea', 'github', 'gitlab']);
    expect(Object.fromEntries(list.map((r) => [r.id, r.label]))).toEqual({ gitea: 'Gitea / Forgejo', github: 'GitHub', gitlab: 'GitLab' });
    expect(list.find((r) => r.id === 'gitlab')?.changeRequestLabel).toBe('merge request');
    expect(list.find((r) => r.id === 'gitea')).toMatchObject({ changeRequestLabel: 'pull request', selfHosted: true, baseUrlRequired: true, oauth: false });
  });

  test('the Gitea / Forgejo connect dialog always asks for the instance URL', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitea').click();
    await expect(page.getByTestId('gitea-import')).toBeVisible();
    const disconnect = page.getByTestId('gitea-disconnect');
    const tokenInput = page.getByTestId('gitea-token');
    await expect(disconnect.or(tokenInput)).toBeVisible();
    if (await disconnect.isVisible()) await disconnect.click();
    await expect(tokenInput).toBeVisible();
    // no self-hosted toggle: every instance is one, so the field is there from the start
    await expect(page.getByTestId('gitea-selfhosted-toggle')).toHaveCount(0);
    const baseUrl = page.getByTestId('gitea-baseurl');
    await expect(baseUrl).toBeVisible();
    await expect(baseUrl).toHaveAttribute('placeholder', 'https://codeberg.org');
    // a token without an instance is refused client-side before any request
    await tokenInput.fill('e2e-token');
    await page.getByTestId('gitea-connect').click();
    await expect(page.locator('.toast').filter({ hasText: 'instance URL' })).toBeVisible();
    await expect(tokenInput).toBeVisible();
  });
});

test.describe('Gitea / Forgejo sync', () => {
  test.describe.configure({ mode: 'serial' });
  let projectId = '';

  test('PAT connect with the instance URL, then import', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitea').click();
    await expect(page.getByTestId('gitea-import')).toBeVisible();
    const disconnect = page.getByTestId('gitea-disconnect');
    const tokenInput = page.getByTestId('gitea-token');
    await expect(disconnect.or(tokenInput)).toBeVisible();
    if (await disconnect.isVisible()) { await disconnect.click(); await expect(tokenInput).toBeVisible(); }
    // GITEA_API_BASE relaxes the https rule for the mock, so an http instance is accepted here
    await page.getByTestId('gitea-baseurl').fill(`http://localhost:${GITEA}`);
    await tokenInput.fill('e2e-token');
    await page.getByTestId('gitea-connect').click();

    await expect(page.getByTestId('gitea-repos')).toBeVisible();
    await expect(page.getByTestId('gitea-import')).toContainText('Connected as e2e-user');
    const repo = page.getByTestId('gitea-repo-e2e-user/paper');
    await expect(repo).toBeVisible();
    await repo.click();

    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gitea-sync')).toBeVisible();
    projectId = new URL(page.url()).pathname.split('/').pop()!;
    expect(projectId).toBeTruthy();
    await openFile(page, 'main.tex');
    await expect(page.locator('.cm-content')).toContainText('Hello from Forgejo');
  });

  test('push reaches the bare repo, a branch and a pull request follow', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__opened = [];
      window.open = ((url: string) => { (window as any).__opened.push(url); return null; }) as any;
      // The edit below would auto-typeset ~2s later; the spinner that adds to
      // the Typeset button shifts the toolbar, and the open branch menu closes
      // when it slides out from under the pointer.
      window.localStorage.setItem('aldine.autoTypeset', '0');
    });
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await openFile(page, 'main.tex');
    const content = page.locator('.cm-content');
    await expect(content).toContainText('Hello from Forgejo');

    const marker = `E2E-MARKER-${Date.now()}`;
    await page.locator('.cm-line', { hasText: 'Hello from Forgejo' }).click();
    await page.keyboard.type(` ${marker}`);
    await expect(content).toContainText(marker);

    await page.getByTestId('gitea-push-btn').click();
    await expect(page.getByTestId('push-dialog')).toContainText('Push to Gitea / Forgejo');
    await page.getByTestId('push-message').fill('Add e2e marker');
    await page.getByTestId('push-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pushed to Gitea / Forgejo' })).toBeVisible();
    expect(git(['--git-dir', GITEA_BARE, 'show', 'main:main.tex'])).toContain(marker);

    const chip = page.getByTestId('gitea-branch');
    await expect(chip).toContainText('main');
    await chip.click();
    await expect(page.getByTestId('gitea-branch-menu')).toBeVisible();
    await expect(page.getByTestId('gitea-open-pr')).toHaveCount(0);
    const branch = `feature-${Date.now()}`;
    await page.getByTestId('gitea-new-branch').fill(branch);
    await page.getByTestId('gitea-create-branch').click();
    await expect(page.locator('.toast').filter({ hasText: `Created branch ${branch}` })).toBeVisible();
    await expect(chip).toContainText(branch);
    expect(git(['--git-dir', GITEA_BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).toContain(branch);

    await chip.click();
    await expect(page.getByTestId('gitea-branch-menu')).toBeVisible();
    await page.getByTestId('gitea-open-pr').click();
    const dialog = page.getByTestId('pr-dialog');
    await expect(dialog.locator('h2')).toHaveText('Open pull request');
    await expect(dialog).not.toContainText('merge request');
    await page.getByTestId('pr-title').fill('E2E pull request');
    await page.getByTestId('pr-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: /Opened pull request #\d+/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([expect.stringContaining('/pulls/')]);

    const res = await page.request.get(`${GITEA_MOCK}/__pulls`);
    expect(res.ok()).toBeTruthy();
    const list: { repo: string; head: string; base: string; title: string }[] = await res.json();
    const mine = list.filter((m) => m.repo === 'e2e-user/paper' && m.title === 'E2E pull request');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ head: branch, base: 'main' });
  });

  test('publish dialog lists Gitea / Forgejo and publishes to it', async ({ page, request }) => {
    // a re-run (or retry) must not hit "already exists" on the mock
    await request.get(`${GITEA_MOCK}/__delete/${encodeURIComponent('e2e-user/forge-paper')}`);

    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Publish To Forgejo');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('gitea-sync')).toHaveCount(0);

    await page.getByTestId('remote-publish-open').click();
    const modal = page.getByTestId('remote-publish');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('remote-publish-provider-gitea')).toHaveText('Gitea / Forgejo');
    await page.getByTestId('remote-publish-provider-gitea').click();
    await expect(modal).toContainText('Publish to Gitea / Forgejo');

    const nameInput = page.getByTestId('publish-repo-name');
    await expect(nameInput.or(page.getByTestId('gitea-token'))).toBeVisible();
    if (!(await nameInput.isVisible())) {
      await page.getByTestId('gitea-baseurl').fill(`http://localhost:${GITEA}`);
      await page.getByTestId('gitea-token').fill('e2e-token');
      await page.getByTestId('gitea-connect').click();
    }
    await expect(nameInput).toBeVisible();
    await nameInput.fill('forge-paper');
    await expect(page.getByTestId('publish-submit')).toContainText('Publish to Gitea / Forgejo as forge-paper');
    await page.getByTestId('publish-submit').click();

    await expect(page.locator('.toast').filter({ hasText: 'Published to e2e-user/forge-paper' })).toBeVisible();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('gitea-sync')).toBeVisible();
    expect(git(['--git-dir', path.join(GITEA_DATA, 'e2e-user/forge-paper.git'), 'show', 'main:main.tex'])).toContain('\\documentclass');
  });
});

test.describe('GitLab sync', () => {
  test.describe.configure({ mode: 'serial' });
  let projectId = '';

  test('PAT connect and import of a nested-group project', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitlab').click();
    await expect(page.getByTestId('gitlab-import')).toBeVisible();
    await connectWithToken(page);

    await expect(page.getByTestId('gitlab-repos')).toBeVisible();
    const repo = page.getByTestId('gitlab-repo-grp/sub/paper');
    await expect(repo).toBeVisible();
    await repo.click();

    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    projectId = new URL(page.url()).pathname.split('/').pop()!;
    expect(projectId).toBeTruthy();

    await openFile(page, 'main.tex');
    await expect(page.locator('.cm-content')).toContainText('Hello from GitLab');
  });

  test('push carries an edit to the bare repo, pull brings an external commit back', async ({ page }) => {
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await openFile(page, 'main.tex');
    const content = page.locator('.cm-content');
    await expect(content).toContainText('Hello from GitLab');

    // clicking the line lands the caret after its last character
    const marker = `E2E-MARKER-${Date.now()}`;
    await page.locator('.cm-line', { hasText: 'Hello from GitLab' }).click();
    await page.keyboard.type(` ${marker}`);
    await expect(content).toContainText(marker);

    await page.getByTestId('gitlab-push-btn').click();
    await expect(page.getByTestId('push-dialog')).toBeVisible();
    await page.getByTestId('push-message').fill('Add e2e marker');
    await page.getByTestId('push-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pushed to GitLab' })).toBeVisible();
    expect(git(['--git-dir', BARE, 'show', 'main:main.tex'])).toContain(marker);

    // an external commit on the host, then Pull shows it in the open editor
    const external = `External edit ${Date.now()}`;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-e2e-gitlab-'));
    try {
      git(['clone', '-q', BARE, `${work}/clone`]);
      const file = path.join(work, 'clone', 'main.tex');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('\\end{document}', `${external}\n\\end{document}`));
      git(['add', '-A'], `${work}/clone`);
      git(['-c', 'user.email=e2e@aldine.dev', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'external'], `${work}/clone`);
      git(['push', '-q', 'origin', 'main'], `${work}/clone`);
    } finally { fs.rmSync(work, { recursive: true, force: true }); }

    await page.getByTestId('gitlab-pull-btn').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pulled from GitLab' })).toBeVisible();
    await expect(content).toContainText(external);
    await expect(content).toContainText(marker);
  });

  test('create a branch, then open a merge request from it', async ({ page }) => {
    // the app hands the new request to window.open; capture instead of opening a tab
    await page.addInitScript(() => {
      (window as any).__opened = [];
      window.open = ((url: string) => { (window as any).__opened.push(url); return null; }) as any;
    });
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();

    const chip = page.getByTestId('gitlab-branch');
    await expect(chip).toContainText('main');
    await chip.click();
    await expect(page.getByTestId('gitlab-branch-menu')).toBeVisible();
    await expect(page.getByTestId('gitlab-open-pr')).toHaveCount(0); // nothing to merge from the default branch
    await page.getByTestId('gitlab-new-branch').fill('feature-x');
    await page.getByTestId('gitlab-create-branch').click();
    await expect(page.locator('.toast').filter({ hasText: 'Created branch feature-x' })).toBeVisible();
    await expect(chip).toContainText('feature-x');
    expect(git(['--git-dir', BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).toContain('feature-x');

    await chip.click();
    await expect(page.getByTestId('gitlab-branch-menu')).toBeVisible();
    await expect(page.getByTestId('gitlab-branch-feature-x')).toBeVisible();
    await page.getByTestId('gitlab-open-pr').click();
    const dialog = page.getByTestId('pr-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toHaveText('Open merge request');
    await expect(dialog).not.toContainText('pull request');
    await page.getByTestId('pr-title').fill('E2E merge request');
    await page.getByTestId('pr-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: /Opened merge request #\d+/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([expect.stringContaining('/merge_requests/')]);

    const res = await page.request.get(`${MOCK}/__merge_requests`, { headers: AUTH });
    expect(res.ok()).toBeTruthy();
    const mrs: { project: string; source_branch: string; target_branch: string; title: string }[] = await res.json();
    const mine = mrs.filter((m) => m.project === 'grp/sub/paper' && m.title === 'E2E merge request');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source_branch: 'feature-x', target_branch: 'main' });
  });

  test('publish dialog offers both hosts and publishes to GitLab', async ({ page, request }) => {
    // a re-run (or retry) must not hit "has already been taken" on the mock
    await request.delete(`${MOCK}/projects/${encodeURIComponent('e2e-user/my-new-paper')}`, { headers: AUTH });

    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Publish To GitLab');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('gitlab-sync')).toHaveCount(0);

    await page.getByTestId('remote-publish-open').click();
    const modal = page.getByTestId('remote-publish');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('remote-publish-provider-github')).toBeVisible();
    await expect(page.getByTestId('remote-publish-provider-gitlab')).toBeVisible();
    await page.getByTestId('remote-publish-provider-gitlab').click();
    await expect(modal).toContainText('Publish to GitLab');

    // connected from the import test on the same server; a fresh .secrets-e2e needs the token again
    const nameInput = page.getByTestId('publish-repo-name');
    await expect(nameInput.or(page.getByTestId('gitlab-token'))).toBeVisible();
    if (!(await nameInput.isVisible())) {
      await page.getByTestId('gitlab-token').fill('e2e-token');
      await page.getByTestId('gitlab-connect').click();
    }
    await expect(nameInput).toBeVisible();
    await nameInput.fill('my-new-paper');
    await expect(page.getByTestId('publish-submit')).toContainText('Publish to GitLab as my-new-paper');
    await page.getByTestId('publish-submit').click();

    await expect(page.locator('.toast').filter({ hasText: 'Published to e2e-user/my-new-paper' })).toBeVisible();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();

    const created = await request.get(`${MOCK}/projects/${encodeURIComponent('e2e-user/my-new-paper')}`, { headers: AUTH });
    expect(created.status()).toBe(200);
    expect((await created.json()).path_with_namespace).toBe('e2e-user/my-new-paper');
    expect(git(['--git-dir', path.join(GITLAB_DATA, 'e2e-user/my-new-paper.git'), 'show', 'main:main.tex'])).toContain('\\documentclass');
  });

  test('a malformed self-hosted URL is refused with a toast', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-from-gitlab').click();
    await expect(page.getByTestId('gitlab-import')).toBeVisible();

    const disconnect = page.getByTestId('gitlab-disconnect');
    const tokenInput = page.getByTestId('gitlab-token');
    await expect(disconnect.or(tokenInput)).toBeVisible();
    if (await disconnect.isVisible()) await disconnect.click();
    await expect(tokenInput).toBeVisible();

    await expect(page.getByTestId('gitlab-baseurl')).toHaveCount(0);
    await page.getByTestId('gitlab-selfhosted-toggle').check();
    // GITLAB_API_BASE relaxes the https rule for the mock, so a value that is
    // not a URL at all is what the server still refuses here
    await page.getByTestId('gitlab-baseurl').fill('not a url');
    await tokenInput.fill('e2e-token');
    await page.getByTestId('gitlab-connect').click();

    await expect(page.locator('.toast').filter({ hasText: 'URL' })).toBeVisible();
    await expect(tokenInput).toBeVisible(); // still disconnected
    await expect(page.getByTestId('gitlab-repos')).toHaveCount(0);
  });
});
