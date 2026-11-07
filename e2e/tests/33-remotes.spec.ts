import { test, expect } from '../fixtures';
import { startFrom } from './helpers';
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
    await page.getByTestId('new-menu').click();
    await expect(page.getByTestId('new-from-github')).toBeVisible();
    await expect(page.getByTestId('new-from-gitlab')).toBeVisible();
    await expect(page.getByTestId('new-from-gitea')).toContainText('Clone from Gitea / Forgejo…');
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
    await startFrom(page, 'new-from-gitea');
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

  test("the token help links to the host's new-token page with the scope filled in", async ({ page }) => {
    const connectForm = async (item: string, p: string) => {
      await page.goto('/');
      await startFrom(page, item);
      const disconnect = page.getByTestId(`${p}-disconnect`);
      const tokenInput = page.getByTestId(`${p}-token`);
      await expect(disconnect.or(tokenInput)).toBeVisible();
      if (await disconnect.isVisible()) await disconnect.click();
      await expect(tokenInput).toBeVisible();
      return page.getByTestId(`${p}-token-page`);
    };
    let link = await connectForm('new-from-github', 'github');
    await expect(link).toHaveText('Create a token on github.com');
    await expect(link).toHaveAttribute('href', 'https://github.com/settings/tokens/new?scopes=repo&description=Aldine');
    await expect(link).toHaveAttribute('target', '_blank');
    // one repository: a fine-grained token, limited to it
    await page.getByTestId('github-single').click();
    const githubSingle = page.getByTestId('github-single-token-page');
    await expect(githubSingle).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens/new');
    await expect(githubSingle.locator('..')).toContainText('Create a token on github.com, choose only this repository and give it Contents: read and write.');

    link = await connectForm('new-from-gitlab', 'gitlab');
    await expect(link).toHaveAttribute('href', 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
    // a self-hosted instance gets its own page, built from the URL typed in
    await page.getByTestId('gitlab-selfhosted-toggle').check();
    await page.getByTestId('gitlab-baseurl').fill('https://gitlab.example.org/');
    await expect(link).toHaveText('Create a token on gitlab.example.org');
    await expect(link).toHaveAttribute('href', 'https://gitlab.example.org/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
    // the one-repository form links the same way, from its own URL field
    await page.getByTestId('gitlab-single').click();
    const single = page.getByTestId('gitlab-single-token-page');
    await expect(single).toHaveAttribute('href', 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
    await page.getByTestId('gitlab-single-baseurl').fill('https://git.example.net');
    await expect(single).toHaveAttribute('href', 'https://git.example.net/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');

    // Gitea / Forgejo has no canonical instance: no link until one is named
    link = await connectForm('new-from-gitea', 'gitea');
    await expect(link).toHaveCount(0);
    await page.getByTestId('gitea-baseurl').fill('https://codeberg.org');
    await expect(link).toHaveAttribute('href', 'https://codeberg.org/user/settings/applications');
  });
});

test.describe('Gitea / Forgejo sync', () => {
  test.describe.configure({ mode: 'serial' });
  let projectId = '';

  test('PAT connect with the instance URL, then import', async ({ page }) => {
    await page.goto('/');
    await startFrom(page, 'new-from-gitea');
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
    // a repository the list does not return is found by its path or URL
    await expect(page.getByTestId('gitea-repo-other-team/shared-paper')).toHaveCount(0);
    await page.getByTestId('gitea-filter').fill(`http://localhost:${GITEA}/other-team/shared-paper.git`);
    await expect(page.getByTestId('gitea-repo-other-team/shared-paper')).toBeVisible();
    await page.getByTestId('gitea-filter').fill('');
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

    await page.getByTestId('branch-menu').click();
    await page.getByTestId('gitea-push-btn').click();
    await expect(page.getByTestId('push-dialog')).toContainText('Push to Gitea / Forgejo');
    await expect(page.getByTestId('push-message')).toBeFocused();
    // Escape closes it like every other dialog, and nothing is pushed.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('push-dialog')).toHaveCount(0);
    if (!(await page.getByTestId('branch-list').isVisible())) await page.getByTestId('branch-menu').click();
    await page.getByTestId('gitea-push-btn').click();
    await page.getByTestId('push-message').fill('Add e2e marker');
    await page.getByTestId('push-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pushed to Gitea / Forgejo' })).toBeVisible();
    expect(git(['--git-dir', GITEA_BARE, 'show', 'main:main.tex'])).toContain(marker);

    const chip = page.getByTestId('branch-menu');
    await expect(chip).toContainText('main');
    await chip.click();
    await expect(page.getByTestId('branch-list')).toBeVisible();
    await expect(page.getByTestId('gitea-open-pr')).toHaveCount(0);
    const branch = `feature-${Date.now()}`;
    await page.getByTestId('new-branch').click();
    await page.getByTestId('new-branch-name').fill(branch);
    await page.getByTestId('new-branch-create').click();
    await expect(page.locator('.toast').filter({ hasText: `Created branch ${branch}` })).toBeVisible();
    await expect(chip).toContainText(branch);
    expect(git(['--git-dir', GITEA_BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).toContain(branch);

    await chip.click();
    await expect(page.getByTestId('branch-list')).toBeVisible();
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

    await page.getByTestId('branch-menu').click();
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
    await startFrom(page, 'new-from-gitlab');
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
    // poll every second instead of every 90 (the server's fetch TTL is 1 s under e2e)
    await page.addInitScript(() => localStorage.setItem('aldine.remotePollMs', '1000'));
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

    await page.getByTestId('branch-menu').click();
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

    // nobody clicks anything: the open editor notices the new commit by itself
    await expect(page.getByTestId('gitlab-counts')).toContainText('↓1', { timeout: 15_000 });
    // with a commit waiting, Pull sits beside the pill without opening anything
    await expect(page.getByTestId('gitlab-sync-action')).toHaveText('Pull');
    await expect(page.getByTestId('gitlab-sync-action')).toHaveClass(/btn--primary/);
    await expect(page.locator('.toast').filter({ hasText: '1 new commit on GitLab' })).toBeVisible();
    await page.getByTestId('gitlab-pull-toast').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pulled from GitLab' })).toBeVisible();
    await expect(page.getByTestId('gitlab-counts')).toHaveCount(0);
    await expect(page.getByTestId('gitlab-sync-action')).toHaveCount(0);
    await expect(content).toContainText(external);
    await expect(content).toContainText(marker);
  });

  test('an expired token: the pill offers Reconnect, and a new token brings sync back', async ({ page, request }) => {
    expect((await request.post('/api/remotes/gitlab/connect', { data: { token: 'e2e-expiring' } })).ok()).toBeTruthy();
    await request.get(`${MOCK}/__revoke?token=e2e-expiring`);
    try {
      await page.goto(`/p/${projectId}`);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      // the host's branch list is the first call that meets the refused token
      const reconnect = page.getByTestId('gitlab-reconnect');
      await expect(reconnect).toBeVisible();
      await expect(reconnect).toHaveAttribute('title', 'GitLab rejected your token (e2e-user). Reconnect to keep syncing.');

      await reconnect.click();
      await expect(page.getByTestId('gitlab-access-dialog')).toBeVisible();
      await expect(page.getByTestId('gitlab-access-rejected')).toContainText('GitLab rejected your token');
      await expect(page.getByTestId('gitlab-access-source')).toHaveText("e2e-user, with your account's token");
      await page.getByTestId('gitlab-access-connect').click();
      await page.getByTestId('gitlab-token').fill('e2e-token');
      await page.getByTestId('gitlab-connect').click();
      await expect(page.locator('.toast').filter({ hasText: 'Connected your GitLab account' })).toBeVisible();
      await expect(page.getByTestId('gitlab-access-rejected')).toHaveCount(0);
      await page.getByTestId('gitlab-access-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(reconnect).toHaveCount(0);

      // the branch list answers again with the new token
      await page.getByTestId('branch-menu').click();
      await expect(page.getByTestId('gitlab-branch-main')).toBeVisible();
      await expect(page.getByTestId('gitlab-token-rejected')).toHaveCount(0);
    } finally {
      await request.get(`${MOCK}/__revoke?clear=1`);
    }
  });

  test("the owner gives the project its own token, which syncs ahead of the account's", async ({ page, request }) => {
    try {
      await page.goto(`/p/${projectId}`);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('gitlab-access').click();
      await expect(page.getByTestId('gitlab-access-source')).toHaveText("e2e-user, with your account's token");

      // a token the host refuses is not stored
      await page.getByTestId('gitlab-project-token-add').click();
      await expect(page.getByTestId('gitlab-project-token-page')).toHaveAttribute('href', 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Aldine&scopes=api');
      await page.getByTestId('gitlab-project-token').fill('bad');
      await page.getByTestId('gitlab-project-token-save').click();
      await expect(page.locator('.toast').filter({ hasText: 'That token was rejected by GitLab' })).toBeVisible();
      await expect(page.getByTestId('gitlab-project-token-login')).toHaveCount(0);

      await page.getByTestId('gitlab-project-token').fill('e2e-project');
      await page.getByTestId('gitlab-project-token-save').click();
      await expect(page.getByTestId('gitlab-project-token-login')).toHaveText('Token of e2e-user');
      await expect(page.getByTestId('gitlab-access-source')).toHaveText("e2e-user, with this project's token");
      expect(await (await request.get(`/api/projects/${projectId}/remote/access`)).json()).toEqual({
        provider: 'gitlab', source: 'project', login: 'e2e-user', projectToken: { login: 'e2e-user' },
      });

      // the project's token expiring is told apart from the account's
      await request.get(`${MOCK}/__revoke?token=e2e-project`);
      await page.reload();
      await expect(page.getByTestId('gitlab-reconnect')).toHaveAttribute('title', "GitLab rejected this project's token. Replace it to keep syncing.");
      await page.getByTestId('gitlab-reconnect').click();
      await page.getByTestId('gitlab-project-token-remove').click();
      await expect(page.locator('.toast').filter({ hasText: "Removed this project's token" })).toBeVisible();
      await expect(page.getByTestId('gitlab-access-source')).toHaveText("e2e-user, with your account's token");
      await expect(page.getByTestId('gitlab-project-token-add')).toBeVisible();
      await page.getByTestId('gitlab-access-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByTestId('gitlab-reconnect')).toHaveCount(0);
      expect((await (await request.get(`/api/projects/${projectId}/remote/access`)).json()).projectToken).toBeNull();
    } finally {
      await request.get(`${MOCK}/__revoke?clear=1`);
    }
  });

  test('create a branch, then open a merge request from it', async ({ page }) => {
    // the app hands the new request to window.open; capture instead of opening a tab
    await page.addInitScript(() => {
      (window as any).__opened = [];
      window.open = ((url: string) => { (window as any).__opened.push(url); return null; }) as any;
    });
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();

    const chip = page.getByTestId('branch-menu');
    await expect(chip).toContainText('main');
    await chip.click();
    await expect(page.getByTestId('branch-list')).toBeVisible();
    await expect(page.getByTestId('gitlab-open-pr')).toHaveCount(0); // nothing to merge from the default branch
    await page.getByTestId('new-branch').click();
    await page.getByTestId('new-branch-name').fill('feature-x');
    await page.getByTestId('new-branch-create').click();
    await expect(page.locator('.toast').filter({ hasText: 'Created branch feature-x' })).toBeVisible();
    await expect(chip).toContainText('feature-x');
    expect(git(['--git-dir', BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])).toContain('feature-x');

    await chip.click();
    await expect(page.getByTestId('branch-list')).toBeVisible();
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

  test('a collaborator who is not the owner cannot start a branch on the host', async ({ page }) => {
    // This suite runs without accounts, where everyone owns everything; the
    // browser is told it is a signed-in collaborator instead.
    await page.route('**/api/auth/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), authEnabled: true, user: { id: 'member', email: 'member@test.com', name: 'Member' } } });
    });
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), isOwner: false, isMember: true } });
    });
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    await page.getByTestId('branch-menu').click();
    await expect(page.getByTestId('branch-list')).toBeVisible();
    await expect(page.getByTestId('gitlab-pull-btn')).toBeEnabled(); // members still sync
    await expect(page.getByTestId('new-branch')).toBeDisabled();
    await expect(page.getByTestId('new-branch-blocked')).toHaveText('Only the project owner can start a branch on GitLab, because it becomes the branch this project tracks for everyone.');
    await expect(page.getByTestId('new-branch-name')).toHaveCount(0);
    // The editor keeps polling the project; an answer still in flight when
    // the test ends must not reach the next one.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('switching the tracked branch asks first, and waits for a pull when the host has newer commits', async ({ page, request }) => {
    const from: string = (await (await request.get(`/api/projects/${projectId}/remote/branches`)).json()).current;
    const to = `switch-${Date.now()}`;
    const external = `external-${Date.now()}.tex`;
    // someone else pushes to the tracked branch, and a branch to switch to appears
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-e2e-gitlab-'));
    try {
      git(['clone', '-q', BARE, `${work}/clone`]);
      const clone = `${work}/clone`;
      git(['push', '-q', 'origin', `origin/main:refs/heads/${to}`], clone);
      git(['checkout', '-q', '-B', from, `origin/${from}`], clone);
      fs.writeFileSync(path.join(clone, external), 'from elsewhere\n');
      git(['add', '-A'], clone);
      git(['-c', 'user.email=e2e@aldine.dev', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'external'], clone);
      git(['push', '-q', 'origin', from], clone);
    } finally { fs.rmSync(work, { recursive: true, force: true }); }

    // an auto-typeset after the edit shifts the toolbar and closes the open branch menu
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    await page.goto(`/p/${projectId}`);
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    await openFile(page, 'main.tex');
    const content = page.locator('.cm-content');
    const marker = `UNPUSHED-${Date.now()}`;
    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` % ${marker}`);
    await expect(content).toContainText(marker);

    const chip = page.getByTestId('branch-menu');
    const pick = async () => {
      await chip.click();
      await expect(page.getByTestId('branch-list')).toBeVisible();
      await page.getByTestId(`gitlab-branch-${to}`).click();
      await expect(page.getByTestId('dialog-title')).toHaveText(`Switch the whole project to ${to}?`);
      await expect(page.getByTestId('dialog-message')).toHaveText("Everyone's open files will change.");
    };
    // asked first: Cancel changes nothing
    await pick();
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('app-dialog')).toHaveCount(0);
    await expect(chip).toContainText(from);

    // the host has a commit main lacks and main one the host lacks: refused, work kept
    await pick();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: `GitLab has newer commits on ${from}. Pull first, then switch.` })).toBeVisible();
    await expect(chip).toContainText(from);
    await expect(content).toContainText(marker);
    expect(git(['--git-dir', BARE, 'show', `${from}:main.tex`])).not.toContain(marker);

    // Pull from the toast, then the switch goes through and the work is on the host
    await page.getByTestId('gitlab-pull-first').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pulled from GitLab' })).toBeVisible();
    await pick();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: `Switched to ${to}` })).toBeVisible();
    await expect(chip).toContainText(to);
    expect(git(['--git-dir', BARE, 'show', `${from}:main.tex`])).toContain(marker);
    expect(git(['--git-dir', BARE, 'show', `${from}:${external}`])).toContain('from elsewhere');
  });

  test('with manual commits, a pull and a branch switch ask for a message for the waiting edits', async ({ page, request }) => {
    expect((await request.patch(`/api/projects/${projectId}`, { data: { manualCommits: true } })).ok()).toBeTruthy();
    try {
      const from: string = (await (await request.get(`/api/projects/${projectId}/remote/branches`)).json()).current;
      const to = `manual-${Date.now()}`;
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-e2e-gitlab-'));
      try {
        git(['clone', '-q', BARE, `${work}/clone`]);
        git(['push', '-q', 'origin', `origin/${from}:refs/heads/${to}`], `${work}/clone`);
      } finally { fs.rmSync(work, { recursive: true, force: true }); }

      await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
      await page.goto(`/p/${projectId}`);
      await expect(page.getByTestId('gitlab-sync')).toBeVisible();
      await openFile(page, 'main.tex');
      const content = page.locator('.cm-content');
      const typeNote = async (text: string) => {
        await page.locator('.cm-line').first().click();
        await page.keyboard.press('End');
        await page.keyboard.type(` % ${text}`);
        await expect(content).toContainText(text);
      };
      const chip = page.getByTestId('branch-menu');

      await typeNote('WAITING-BEFORE-PULL');
      await chip.click();
      await page.getByTestId('gitlab-pull-btn').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Commit 1 waiting file before pulling');
      await page.getByTestId('dialog-input').fill('Note before pulling');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast').filter({ hasText: 'Pulled from GitLab' })).toBeVisible();
      const log = await (await request.get(`/api/projects/${projectId}/log?branch=main`)).json() as Array<{ message: string }>;
      expect(log[0].message).toBe('Note before pulling');

      const marker = `WAITING-BEFORE-SWITCH-${Date.now()}`;
      await typeNote(marker);
      await chip.click();
      await page.getByTestId(`gitlab-branch-${to}`).click();
      await expect(page.getByTestId('dialog-title')).toHaveText(`Switch the whole project to ${to}?`);
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Commit 1 waiting file before switching branch');
      await page.getByTestId('dialog-input').fill('Note before switching');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast').filter({ hasText: `Switched to ${to}` })).toBeVisible();
      await expect(chip).toContainText(to);
      expect(git(['--git-dir', BARE, 'log', '-1', '--format=%s', from]).trim()).toBe('Note before switching');
      expect(git(['--git-dir', BARE, 'show', `${from}:main.tex`])).toContain(marker);
    } finally {
      await request.patch(`/api/projects/${projectId}`, { data: { manualCommits: false } });
    }
  });

  test('clone one repository with its own token, which stays with that project', async ({ page, request }) => {
    expect((await request.post('/api/remotes/gitlab/connect', { data: { token: 'e2e-token' } })).ok()).toBeTruthy();
    await page.goto('/');
    await startFrom(page, 'new-from-gitlab');
    await expect(page.getByTestId('gitlab-import')).toBeVisible();
    await page.getByTestId('gitlab-single').click();
    // a pasted web URL is read as its path
    await page.getByTestId('gitlab-single-repo').fill(`${MOCK}/grp/sub/paper`);
    await page.getByTestId('gitlab-single-token').fill('e2e-single');
    await page.getByTestId('gitlab-single-clone').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    const id = new URL(page.url()).pathname.split('/').pop()!;
    expect(await (await request.get(`/api/projects/${id}/remote/access`)).json()).toMatchObject({ source: 'project', projectToken: { login: 'e2e-user' } });
    // the account connection is untouched: revoking the single token leaves it working
    await request.get(`${MOCK}/__revoke?token=e2e-single`);
    try {
      expect((await request.get('/api/remotes/gitlab/repos')).ok()).toBeTruthy();
      expect((await request.get(`/api/projects/${id}/remote/branches`)).status()).toBe(401);
    } finally {
      await request.get(`${MOCK}/__revoke?clear=1`);
    }
  });

  test('Replace token in the clone dialog swaps the account connection in place', async ({ page }) => {
    await page.goto('/');
    await startFrom(page, 'new-from-gitlab');
    await connectWithToken(page);
    await expect(page.getByTestId('gitlab-repo-grp/sub/paper')).toBeVisible();
    await page.getByTestId('gitlab-replace-token').click();
    await page.getByTestId('gitlab-token').fill('bad');
    await page.getByTestId('gitlab-connect').click();
    await expect(page.locator('.toast').filter({ hasText: 'That token was rejected by GitLab' })).toBeVisible();
    await page.getByTestId('gitlab-token').fill('e2e-token-2');
    await page.getByTestId('gitlab-connect').click();
    await expect(page.getByTestId('gitlab-token')).toHaveCount(0);
    await expect(page.getByTestId('gitlab-repo-grp/sub/paper')).toBeVisible();
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

    await page.getByTestId('branch-menu').click();
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

  test('Publish opens from the nudge and the palette, and a failed first push still links the project', async ({ page, request }) => {
    await request.delete(`${MOCK}/projects/${encodeURIComponent('e2e-user/push-fails')}`, { headers: AUTH });
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Push Fails');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();

    // the one-time nudge carries the way to Publish
    const modal = page.getByTestId('remote-publish');
    await page.getByTestId('remote-nudge-publish').click();
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    // and the palette finds it by the host's name
    await page.getByTestId('palette-open').click();
    await page.getByTestId('palette-input').fill('gitlab');
    await expect(page.getByTestId('palette-item-remote-publish')).toHaveText(/Publish to a git host…/);
    await page.getByTestId('palette-item-remote-publish').click();
    await expect(modal).toBeVisible();

    await page.getByTestId('remote-publish-provider-gitlab').click();
    const nameInput = page.getByTestId('publish-repo-name');
    await expect(nameInput.or(page.getByTestId('gitlab-token'))).toBeVisible();
    if (!(await nameInput.isVisible())) {
      await page.getByTestId('gitlab-token').fill('e2e-token');
      await page.getByTestId('gitlab-connect').click();
    }
    await nameInput.fill('push-fails');
    await request.get(`${MOCK}/__failpush?on=1`);
    try {
      await page.getByTestId('publish-submit').click();
      // linked although the push failed: the dialog closes onto the synced pill
      await expect(page.locator('.toast').filter({ hasText: 'Repository created but the first push failed' })).toBeVisible();
      await expect(modal).toHaveCount(0);
      await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    } finally {
      await request.get(`${MOCK}/__failpush?on=0`);
    }
    // the toast's Push opens the push dialog, and this time it lands
    await page.getByTestId('publish-push-retry').click();
    await expect(page.getByTestId('push-dialog')).toBeVisible();
    await page.getByTestId('push-confirm').click();
    await expect(page.locator('.toast').filter({ hasText: 'Pushed to GitLab' })).toBeVisible();
    expect(git(['--git-dir', path.join(GITLAB_DATA, 'e2e-user/push-fails.git'), 'show', 'main:main.tex'])).toContain('\\documentclass');
  });

  test('a malformed self-hosted URL is refused with a toast', async ({ page }) => {
    await page.goto('/');
    await startFrom(page, 'new-from-gitlab');
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
