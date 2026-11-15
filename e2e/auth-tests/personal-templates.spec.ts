import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Browser } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * Personal template repositories (#308): added in Account settings, their
 * templates show in the owner's New project gallery under an "only you"
 * group and seed a project; another account neither lists them, nor gets
 * their preview, nor can create a project from them. Removing the
 * repository takes the templates out of the gallery. The bare repository is
 * a file:// fixture under .data-auth, accepted only under ALDINE_TEST_HOOKS
 * (playwright.auth.config.ts sets it).
 */
const ROOT = path.resolve(__dirname, '..', '..');
const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();

function bareRepo(): { url: string; dir: string } {
  const base = path.join(ROOT, '.data-auth', `personal-templates-${Date.now()}`);
  const bare = `${base}.git`;
  const work = `${base}-work`;
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  git(path.dirname(base), 'clone', '-q', bare, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(work, 'letter'));
  fs.writeFileSync(path.join(work, 'letter', 'template.json'), JSON.stringify({ name: 'Home letter', description: 'With my address' }));
  fs.writeFileSync(path.join(work, 'letter', 'main.tex'), '\\documentclass{letter}\n\\address{12 Example Street}\n\\signature{{{AUTHOR}}}\n\\begin{document}\nHello.\n\\end{document}\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'letter');
  git(work, 'push', '-q', 'origin', 'main');
  fs.rmSync(work, { recursive: true, force: true });
  return { url: pathToFileURL(bare).href, dir: bare };
}

async function signUp(browser: Browser, name: string, ip: string) {
  // its own client address keeps it off the sign-in limit the suite shares
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('auth-switch').click();
  await page.getByTestId('auth-name').fill(name);
  await page.getByTestId('auth-email').fill(uniq());
  await page.getByTestId('auth-password').fill('password123');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('new-project')).toBeVisible({ timeout: 15_000 });
  return { ctx, page };
}

test('a personal template repository is listed and used by its owner only (#308)', async ({ browser }) => {
  test.skip(!!process.env.ALDINE_AUTH_URL, 'serves the repository from the local disk');
  const repo = bareRepo();
  const { ctx, page } = await signUp(browser, 'Ada Owner', '203.0.113.71');
  try {
    await page.getByTestId('account-menu').click();
    await page.getByTestId('user-name').click();
    const settings = page.getByTestId('account-settings');
    const section = settings.getByTestId('account-templates');
    await expect(section).toContainText('only you see');
    await section.getByTestId('account-templates-add').click();
    await section.getByTestId('account-templates-url').fill('https://user:secret@example.com/t.git');
    await section.getByTestId('account-templates-save').click();
    await expect(section.getByTestId('account-templates-error-text')).toContainText('Leave the token out of the URL');
    await section.getByTestId('account-templates-url').fill(repo.url);
    await section.getByTestId('account-templates-label').fill('My letters');
    await section.getByTestId('account-templates-save').click();
    await expect(page.locator('.toast', { hasText: 'Added My letters: 1 template' })).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId('account-template-repo-my-letters-count')).toHaveText(' · 1 template');
    await page.keyboard.press('Escape');

    const { repos } = await (await page.request.get('/api/templates/personal')).json();
    const repoId: string = repos[0].repoId;
    const tplId = `repo:${repoId}/letter`;

    await page.getByTestId('new-project').click();
    await expect(page.getByTestId('template-grid')).toBeVisible();
    const group = page.getByTestId(`template-category-repo-${repoId}`);
    await expect(group).toContainText('My letters');
    await expect(page.getByTestId(`template-repo-personal-${repoId}`)).toHaveText('only you');
    await page.getByTestId('new-project-name').fill('Letter to the bank');
    await group.getByTestId(`template-${tplId}`).click();
    await expect(page.getByTestId('template-choice')).toContainText('Home letter');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    const editor = page.locator('.cm-content');
    await expect(editor).toContainText('12 Example Street');
    await expect(editor).toContainText('\\signature{Ada Owner}');

    // Another account: not listed, no preview, no project from it.
    const other = await signUp(browser, 'Bob Other', '203.0.113.72');
    try {
      const theirs = (await (await other.page.request.get('/api/templates')).json()) as Array<{ id: string }>;
      expect(theirs.map((t) => t.id)).not.toContain(tplId);
      const states = (await (await other.page.request.get('/api/templates/repos')).json()).repos as Array<{ id: string }>;
      expect(states.map((s) => s.id)).not.toContain(repoId);
      expect((await other.page.request.get(`/api/templates/preview?id=${encodeURIComponent(tplId)}`)).status()).toBe(404);
      const created = await other.page.request.post('/api/projects', { data: { name: 'Borrowed', template: tplId } });
      expect(created.ok()).toBeFalsy();
      expect((await (await other.page.request.get('/api/templates/personal')).json()).repos).toEqual([]);
      expect((await other.page.request.delete('/api/templates/personal/my-letters')).status()).toBe(404);
    } finally {
      await other.ctx.close();
    }

    // Removing it takes the templates out of the owner's gallery.
    await page.goto('/');
    await page.getByTestId('account-menu').click();
    await page.getByTestId('user-name').click();
    await page.getByTestId('account-template-repo-my-letters-remove').click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.toast', { hasText: 'Removed My letters' })).toBeVisible();
    await expect(page.getByTestId('account-template-repo-my-letters')).toHaveCount(0);
    const mine = (await (await page.request.get('/api/templates')).json()) as Array<{ id: string }>;
    expect(mine.map((t) => t.id)).not.toContain(tplId);
  } finally {
    await ctx.close();
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});
