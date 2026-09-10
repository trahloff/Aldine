import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Templates from a git repository (#50). playwright.config.ts hands the app
 * server TEMPLATE_REPOS pointing at a file:// bare repository under .data-e2e
 * (accepted only under ALDINE_TEST_HOOKS). The server boots before this spec
 * runs, so the repository is built here and the boot sync has already failed:
 * the first refresh is what produces the checkout. The bare repository is a
 * fixture this spec owns; it is rebuilt before and removed after the run so a
 * second run starts from the same "nothing cloned yet" state.
 */
interface RepoState { id: string; label: string; ok: boolean; available: boolean; head?: string; syncedAt?: string; error?: string }
interface Template { id: string; name: string; category?: string; source?: { kind: string; label?: string } }

const ROOT = path.resolve(__dirname, '..', '..');
const BARE = path.join(ROOT, '.data-e2e', 'template-repo.git');
const BARE_AWAY = `${BARE}.away`;
// The checkout the server keeps for repository "lab" (CACHE_DIR default).
const CHECKOUT = path.join(ROOT, '.cache', 'latex', 'template-repos', 'lab');

// Not UTF-8: a text round-trip would replace 0x89/0xff, a placeholder pass
// would have to leave every byte alone.
const LOGO = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  Buffer.from(Array.from({ length: 54 }, (_, i) => (i * 37 + 11) & 0xff)),
]);
const THESIS_TEX = [
  '\\documentclass{report}',
  '\\title{{{PROJECT_NAME}}}',
  '\\author{{{AUTHOR}}}',
  '\\date{{{DATE}}}',
  '% Lab thesis template, {{YEAR}} edition',
  '\\begin{document}',
  '\\maketitle',
  '\\includegraphics{logo.png}',
  '\\end{document}',
  '',
].join('\n');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();

/** Clone the bare repository, write `files`, commit and push to main. */
function commitToBare(message: string, files: Record<string, Buffer | string>) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-e2e-template-repo-'));
  try {
    git(work, 'clone', '-q', BARE, '.');
    git(work, 'config', 'user.email', 'e2e@example.com');
    git(work, 'config', 'user.name', 'E2E');
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(work, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function rebuildBare() {
  fs.rmSync(BARE, { recursive: true, force: true });
  fs.rmSync(BARE_AWAY, { recursive: true, force: true });
  fs.mkdirSync(BARE, { recursive: true });
  git(BARE, 'init', '-q', '--bare', '-b', 'main');
  commitToBare('Lab thesis template', {
    'thesis/template.json': JSON.stringify({ name: 'Lab thesis', description: 'The lab\u2019s thesis layout', category: 'Theses' }, null, 2),
    'thesis/main.tex': THESIS_TEX,
    'thesis/logo.png': LOGO,
  });
}

async function repoStates(request: APIRequestContext): Promise<RepoState[]> {
  const res = await request.get('/api/templates/repos');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { repos: RepoState[] }).repos;
}

async function refresh(request: APIRequestContext): Promise<RepoState[]> {
  const res = await request.post('/api/templates/repos/refresh');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { repos: RepoState[] }).repos;
}

async function openGallery(page: Page) {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('template-grid')).toBeVisible();
}

/** Click "Refresh templates" and wait for the round trip to finish. */
async function refreshFromDialog(page: Page) {
  const button = page.getByTestId('template-refresh');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}

test.describe('templates from a git repository', () => {
  test.describe.configure({ mode: 'serial' });
  // A stack started elsewhere (compose) has no way to reach a bare repo built here.
  test.skip(!!process.env.ALDINE_URL, 'needs the Playwright-started server, whose TEMPLATE_REPOS names the bare repo this spec builds');

  let bareExistedAtBoot = false;

  test.beforeAll(async ({ request }) => {
    // Either could be left behind by an interrupted earlier run.
    bareExistedAtBoot = fs.existsSync(BARE) || fs.existsSync(CHECKOUT);
    rebuildBare();
    // The boot sync ran against a repository that did not exist yet.
    const before = (await repoStates(request)).find((r) => r.id === 'lab');
    expect(before, 'TEMPLATE_REPOS lists the lab repository').toBeTruthy();
    expect(before!.label).toBe('Lab templates');
    if (!bareExistedAtBoot) {
      expect(before!.ok).toBe(false);
      expect(before!.available).toBe(false);
    }
    const after = (await refresh(request)).find((r) => r.id === 'lab')!;
    expect(after.ok, after.error ?? '').toBe(true);
  });

  test.afterAll(async () => {
    fs.rmSync(BARE, { recursive: true, force: true });
    fs.rmSync(BARE_AWAY, { recursive: true, force: true });
    fs.rmSync(CHECKOUT, { recursive: true, force: true });
  });

  test('the repository is listed, synced, and its folder is a template', async ({ request }) => {
    const lab = (await repoStates(request)).find((r) => r.id === 'lab')!;
    expect(lab.ok).toBe(true);
    expect(lab.available).toBe(true);
    expect(lab.head).toMatch(/^[0-9a-f]{40}$/);
    expect(lab.head).toBe(git(BARE, 'rev-parse', 'main'));
    expect(lab.syncedAt).toBeTruthy();
    expect(lab.error).toBeUndefined();

    const templates = (await (await request.get('/api/templates')).json()) as Template[];
    const thesis = templates.find((t) => t.id === 'repo:lab/thesis');
    expect(thesis, 'repo:lab/thesis is in the gallery list').toBeTruthy();
    expect(thesis!.name).toBe('Lab thesis');
    expect(thesis!.source).toEqual({ kind: 'repo', label: 'Lab templates' });
    // The built-in tiles are untouched by the repository.
    expect(templates.map((t) => t.id)).toEqual(expect.arrayContaining(['article', 'report']));
  });

  test('the gallery groups the tile under the repository, not its category', async ({ page }) => {
    await openGallery(page);

    const group = page.getByTestId('template-category-repo-lab');
    await expect(group).toBeVisible();
    await expect(group.locator('.tpl-group__label')).toContainText('Lab templates');
    const tile = page.getByTestId('template-repo:lab/thesis');
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Lab thesis');
    await expect(page.getByTestId('template-source-repo:lab/thesis')).toHaveText('Lab templates');
    // The manifest says Theses; the repository label wins over the category.
    await expect(group.getByTestId('template-repo:lab/thesis')).toHaveCount(1);
    await expect(page.getByTestId('template-category-Theses').getByTestId('template-repo:lab/thesis')).toHaveCount(0);
    // Repository groups sit right after the built-in General group.
    const order = await page.locator('.tpl-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order.indexOf('template-category-repo-lab')).toBe(order.indexOf('template-category-General') + 1);

    const search = page.getByTestId('template-search');
    await search.fill('Lab');
    await expect(tile).toBeVisible();
    await search.fill('zzzz');
    await expect(tile).toHaveCount(0);
    await expect(page.getByTestId('template-empty')).toBeVisible();
  });

  test('a project created from the tile has the placeholders filled and the logo byte-exact', async ({ page, request }) => {
    await openGallery(page);
    await page.getByTestId('new-project-name').fill('Repo Thesis');
    await page.getByTestId('template-repo:lab/thesis').click();
    await expect(page.getByTestId('template-choice')).toContainText('Lab thesis');
    await page.getByTestId('create-project').click();

    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    const editor = page.locator('.cm-content');
    await expect(editor).toContainText('\\title{Repo Thesis}');
    await expect(editor).toContainText(`${new Date().getUTCFullYear()} edition`);
    await expect(editor).not.toContainText('{{');

    // The tree shows images in source-only view already; "All" is the state
    // the assertion is meant to hold in, so make it explicit.
    const toggle = page.getByTestId('source-only');
    if ((await toggle.textContent())?.includes('All')) await toggle.click();
    await expect(toggle).toContainText('Source');
    await expect(page.getByTestId('file-logo.png')).toBeVisible();
    await expect(page.getByTestId('file-template.json')).toHaveCount(0);

    const id = new URL(page.url()).pathname.split('/').pop()!;
    const logo = await request.get(`/api/projects/${id}/file?branch=main&path=logo.png`);
    expect(logo.ok()).toBeTruthy();
    expect(Buffer.from(await logo.body()).equals(LOGO)).toBe(true);
    const main = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
    expect(main).toContain('\\title{Repo Thesis}');
    expect(main).toContain(`\\date{${new Date().toISOString().slice(0, 10)}}`);
    expect(main).not.toContain('{{');
    // Only the template's files (plus the .gitignore every project starts with): the manifest stays behind.
    const files = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { path: string }[];
    expect(files.map((f) => f.path).filter((f) => f !== '.gitignore').sort()).toEqual(['logo.png', 'main.tex']);
  });

  test('a new commit shows up after "Refresh templates", not before', async ({ page }) => {
    await openGallery(page);
    await expect(page.getByTestId('template-repo:lab/thesis')).toBeVisible();

    commitToBare('Poster template', {
      'poster/template.json': JSON.stringify({ name: 'Lab poster', description: 'A0 poster', category: 'Slides' }),
      'poster/main.tex': '\\documentclass{article}\n\\begin{document}{{PROJECT_NAME}}\\end{document}\n',
    });
    await expect(page.getByTestId('template-repo:lab/poster')).toHaveCount(0);

    await refreshFromDialog(page);
    const poster = page.getByTestId('template-repo:lab/poster');
    await expect(poster).toBeVisible();
    await expect(page.getByTestId('template-category-repo-lab').getByTestId('template-repo:lab/poster')).toHaveCount(1);
    await expect(page.getByTestId('template-source-repo:lab/poster')).toHaveText('Lab templates');
    await expect(page.getByTestId('template-repo:lab/thesis')).toBeVisible();
    await expect(page.getByTestId('template-repo-stale-lab')).toHaveCount(0);
  });

  test('an unreachable repository is marked stale, its tiles stay, and it recovers', async ({ page, request }) => {
    await openGallery(page);
    fs.renameSync(BARE, BARE_AWAY);
    try {
      await refreshFromDialog(page);
      const stale = page.getByTestId('template-repo-stale-lab');
      await expect(stale).toBeVisible();
      await expect(stale).toContainText('refresh failed');
      await expect(page.getByTestId('template-repo:lab/thesis')).toBeVisible();
      await expect(page.getByTestId('template-repo:lab/poster')).toBeVisible();
      const lab = (await repoStates(request)).find((r) => r.id === 'lab')!;
      expect(lab.ok).toBe(false);
      expect(lab.available).toBe(true);
      expect(lab.error).toBeTruthy();
    } finally {
      fs.renameSync(BARE_AWAY, BARE);
    }

    await refreshFromDialog(page);
    await expect(page.getByTestId('template-repo-stale-lab')).toHaveCount(0);
    await expect(page.getByTestId('template-repo:lab/thesis')).toBeVisible();
    const lab = (await repoStates(request)).find((r) => r.id === 'lab')!;
    expect(lab.ok).toBe(true);
    expect(lab.head).toBe(git(BARE, 'rev-parse', 'main'));
  });
});
