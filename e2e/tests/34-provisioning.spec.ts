import { test, expect } from '../fixtures';
import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * GitLab auto-provisioning (#51 Stage B), run by playwright.provisioning.config.ts
 * against an app server with GITLAB_TOKEN + GITLAB_DEFAULT_GROUP=research/latex
 * and AUTOPUSH_DEBOUNCE_MS=400. The mock (tests/mock-gitlab.mjs) holds real bare
 * repos under .data-e2e-gitlab and exposes test switches under /__*. Projects
 * created here are removed at the end so the Home grid does not grow run over run.
 */
const PORT = Number(process.env.E2E_PROV_PORT || 3300);
const GITLAB = Number(process.env.E2E_PROV_GITLAB_PORT || 4925);
const BASE = process.env.ALDINE_PROV_URL || `http://localhost:${PORT}`;
const MOCK = `http://localhost:${GITLAB}`;
const AUTH = { authorization: 'Bearer x' };
const GITLAB_DATA = path.resolve(__dirname, '../../.data-e2e-gitlab');
const ROOT = 'research/latex';

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Read a mock GitLab endpoint (`/__projects`, `/__deleted`, switches, or the API itself). */
async function mock<T = any>(p: string): Promise<T> {
  const res = await fetch(`${MOCK}${p}`, { headers: AUTH });
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json() as Promise<T>;
}
const mockPaths = async () => (await mock<{ path_with_namespace: string }[]>('/__projects')).map((p) => p.path_with_namespace);
const bareOf = (fullName: string) => path.join(GITLAB_DATA, `${fullName}.git`);
/** main:main.tex of a bare repo, '' while the ref does not exist yet. */
const bareMainTex = (fullName: string) => {
  try { return git(['--git-dir', bareOf(fullName), 'show', 'main:main.tex']); } catch { return ''; }
};

type Summary = {
  id: string; name: string; autopush?: boolean;
  remote?: { provider: string; fullName: string; owner: string } | null;
  remotePending?: { provider: string; namespace: string } | null;
};
const summary = async (request: APIRequestContext, id: string): Promise<Summary> => {
  const res = await request.get(`/api/projects/${id}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
};

/** Create through the Home dialog; resolves with the new project's id once the editor is open. */
async function createViaDialog(page: Page, name: string, namespace?: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('new-project-name').fill(name);
  const select = page.getByTestId('namespace-select');
  await expect(select).toBeVisible();
  if (namespace) await select.selectOption(namespace);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

async function openFile(page: Page, name: string) {
  await expect(page.getByTestId(`file-${name}`)).toBeVisible();
  await page.getByTestId(`file-${name}`).click();
}

/** Append `text` to the `\begin{document}` line and wait for the collab flush to reach the worktree. */
async function typeAndFlush(page: Page, request: APIRequestContext, id: string, text: string) {
  await page.locator('.cm-line', { hasText: 'begin{document}' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(` ${text}`);
  await expect(page.locator('.cm-content')).toContainText(text);
  await expect.poll(async () => (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text(), { timeout: 10_000 })
    .toContain(text);
}

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

test.describe('GitLab auto-provisioning', () => {
  test.describe.configure({ mode: 'serial' });
  const created: string[] = [];
  let teamPaperId = '';
  let teamPaperRepo = '';

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext({ baseURL: BASE });
    try {
      await mock('/__fail?on=0');
      for (const id of created) await ctx.delete(`/api/projects/${id}?permanent=1`).catch(() => {});
    } finally { await ctx.dispose(); }
  });

  test('a new project lands in the root group with autopush on', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await expect(page.getByTestId('namespace-picker')).toBeVisible();
    const options = await page.getByTestId('namespace-select').locator('option').allTextContents();
    expect(options).toEqual(expect.arrayContaining([ROOT, `${ROOT}/team-a`]));
    expect(options).not.toContain('research/latex-archive'); // shares the prefix, is not inside the root
    expect(options[0]).toBe(ROOT);

    await page.getByTestId('new-project-name').fill('Team Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    teamPaperId = new URL(page.url()).pathname.split('/').pop()!;
    created.push(teamPaperId);
    await expect(page.locator('.toast').filter({ hasText: 'Also created on GitLab' })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: 'Also created on GitLab' })).toContainText(ROOT);

    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    const autopush = page.getByTestId('gitlab-autopush');
    await expect(autopush).toHaveText('Autopush on');
    await expect(autopush).toHaveAttribute('aria-pressed', 'true');

    const s = await summary(request, teamPaperId);
    expect(s.remote?.fullName).toMatch(/^research\/latex\/team-paper(-\d+)?$/);
    teamPaperRepo = s.remote!.fullName;
    expect(await mockPaths()).toContain(teamPaperRepo);
    // the first push happened as part of provisioning
    expect(fs.existsSync(bareOf(teamPaperRepo))).toBe(true);
    expect(bareMainTex(teamPaperRepo)).toContain('\\documentclass');
  });

  test('a chosen subgroup is remembered; a new subgroup can be created from the dialog', async ({ page, request }) => {
    const subId = await createViaDialog(page, 'Sub Paper', `${ROOT}/team-a`);
    created.push(subId);
    expect((await summary(request, subId)).remote?.fullName).toMatch(/^research\/latex\/team-a\/sub-paper(-\d+)?$/);
    expect(await mockPaths()).toEqual(expect.arrayContaining([expect.stringMatching(/^research\/latex\/team-a\/sub-paper(-\d+)?$/)]));

    await page.goto('/');
    await page.getByTestId('new-project').click();
    const select = page.getByTestId('namespace-select');
    await expect(select).toHaveValue(`${ROOT}/team-a`); // localStorage remembers the last pick

    // the new subgroup goes under the selected group, so pick the root first;
    // a retry of this test finds team-b already on the mock: pick it instead of re-creating
    if ((await select.locator(`option[value="${ROOT}/team-b"]`).count()) === 0) {
      await select.selectOption(ROOT);
      await page.getByTestId('namespace-new').click();
      await page.getByTestId('namespace-new-name').fill('Team B');
      await page.getByTestId('namespace-new-create').click();
      await expect(page.locator('.toast').filter({ hasText: `Created group ${ROOT}/team-b` })).toBeVisible();
    } else {
      await select.selectOption(`${ROOT}/team-b`);
    }
    await expect(select.locator(`option[value="${ROOT}/team-b"]`)).toHaveCount(1);
    await expect(select).toHaveValue(`${ROOT}/team-b`);

    await page.getByTestId('new-project-name').fill('B Paper');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    const bId = new URL(page.url()).pathname.split('/').pop()!;
    created.push(bId);
    expect((await summary(request, bId)).remote?.fullName).toMatch(/^research\/latex\/team-b\/b-paper(-\d+)?$/);
    expect(await mockPaths()).toEqual(expect.arrayContaining([expect.stringMatching(/^research\/latex\/team-b\/b-paper(-\d+)?$/)]));
  });

  test('autopush pushes a commit within the debounce; off holds it back, on releases it', async ({ page, request }) => {
    await page.goto(`/p/${teamPaperId}`);
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await openFile(page, 'main.tex');
    const autopush = page.getByTestId('gitlab-autopush');
    await expect(autopush).toHaveAttribute('aria-pressed', 'true');

    // The autosave commit waits 20 s after edits settle; the commit route takes
    // the same path (flush, commit, scheduleAutopush) without the wait.
    const first = `E2E-AUTOPUSH-${Date.now()}`;
    await typeAndFlush(page, request, teamPaperId, first);
    expect((await (await request.post(`/api/projects/${teamPaperId}/commit`, { data: { branch: 'main', message: 'e2e' } })).json()).committed).toBe(true);
    await expect.poll(() => bareMainTex(teamPaperRepo), { timeout: 4_000 }).toContain(first);

    await autopush.click();
    await expect(autopush).toHaveAttribute('aria-pressed', 'false');
    await expect(autopush).toHaveText('Autopush off');
    const second = `E2E-HELD-${Date.now()}`;
    await typeAndFlush(page, request, teamPaperId, second);
    expect((await (await request.post(`/api/projects/${teamPaperId}/commit`, { data: { branch: 'main', message: 'e2e held' } })).json()).committed).toBe(true);
    await page.waitForTimeout(1500); // > debounce: an enabled autopush would have landed by now
    expect(bareMainTex(teamPaperRepo)).not.toContain(second);

    await autopush.click();
    await expect(autopush).toHaveAttribute('aria-pressed', 'true');
    await request.post(`/api/projects/${teamPaperId}/commit`, { data: { branch: 'main', message: 'e2e released' } });
    await expect.poll(() => bareMainTex(teamPaperRepo), { timeout: 4_000 }).toContain(second);
  });

  test('GitLab down at create time: the project exists, the banner retries the remote', async ({ page, request }) => {
    await mock('/__fail?on=1');
    try {
      const id = await createViaDialog(page, 'Offline Paper');
      created.push(id);
      // the editor's own "lives only on this server" hint also names GitLab; the warning is the one with the cause
      await expect(page.locator('.toast').filter({ hasText: 'Could not create the GitLab project' })).toContainText('503');
      const banner = page.getByTestId('remote-pending');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(ROOT);
      await expect(page.getByTestId('gitlab-sync')).toHaveCount(0);
      const before = await summary(request, id);
      expect(before.remote ?? null).toBeNull();
      expect(before.remotePending).toMatchObject({ provider: 'gitlab', namespace: ROOT });

      await mock('/__fail?on=0');
      await page.getByTestId('remote-pending-retry').click();
      await expect(page.getByTestId('gitlab-sync')).toBeVisible();
      await expect(banner).toHaveCount(0);
      const after = await summary(request, id);
      expect(after.remote?.fullName).toMatch(/^research\/latex\/offline-paper(-\d+)?$/);
      expect(after.remotePending ?? null).toBeNull();
      expect(await mockPaths()).toContain(after.remote!.fullName);
    } finally {
      await mock('/__fail?on=0');
    }
  });

  test('delete removes the GitLab project, restore re-creates it, an imported repository survives', async ({ page, request }) => {
    await page.goto('/');
    const card = page.getByTestId(`project-card-${teamPaperId}`);
    await expect(card).toBeVisible();
    page.on('dialog', (d) => d.accept());
    await card.locator('.project-card__del').click();
    await expect(card).not.toBeVisible();
    // delayed deletion on the mock: marked, then purged by path — both by the server
    expect(await mock<string[]>('/__deleted')).toContain(teamPaperRepo);
    expect(await mockPaths()).not.toContain(teamPaperRepo);
    expect(fs.existsSync(bareOf(teamPaperRepo))).toBe(false);
    const trash: { id: string }[] = await (await request.get('/api/projects/trash')).json();
    expect(trash.map((t) => t.id)).toContain(teamPaperId);

    await page.getByTestId('open-trash').click();
    await page.getByTestId(`restore-${teamPaperId}`).click();
    await expect(page.locator('.toast').filter({ hasText: 'Restored Team Paper' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toBeVisible();
    const restored = await summary(request, teamPaperId);
    // the purge freed the slug; a refused purge would have given the re-creation a suffix
    expect(restored.remote?.fullName).toMatch(/^research\/latex\/team-paper(-\d+)?$/);
    expect(restored.remotePending ?? null).toBeNull();
    teamPaperRepo = restored.remote!.fullName;
    expect(await mockPaths()).toContain(teamPaperRepo);
    await expect.poll(() => bareMainTex(teamPaperRepo), { timeout: 10_000 }).toContain('\\documentclass');

    // imported from GitLab: Aldine did not create it, so deleting the project never deletes the repository
    await page.getByTestId('new-from-gitlab').click();
    await expect(page.getByTestId('gitlab-import')).toBeVisible();
    await connectWithToken(page);
    await expect(page.getByTestId('gitlab-repos')).toBeVisible();
    await page.getByTestId('gitlab-repo-grp/sub/paper').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gitlab-sync')).toBeVisible();
    const importedId = new URL(page.url()).pathname.split('/').pop()!;
    expect((await summary(request, importedId)).remote?.fullName).toBe('grp/sub/paper');

    const del = await request.delete(`/api/projects/${importedId}?permanent=1`);
    expect(del.ok()).toBeTruthy();
    expect(await del.json()).toEqual({ ok: true });
    expect(await mock<string[]>('/__deleted')).not.toContain('grp/sub/paper');
    expect(await mockPaths()).toContain('grp/sub/paper');
    expect(fs.existsSync(bareOf('grp/sub/paper'))).toBe(true);
  });

  test('a namespace outside the root group is refused by the API, the project still exists', async ({ request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Sneaky', namespace: 'research/latex-archive' } });
    expect(res.status()).toBe(200);
    const body: Summary & { remoteError?: string } = await res.json();
    created.push(body.id);
    expect(body.remoteError).toMatch(/outside/);
    expect(body.remote ?? null).toBeNull();
    expect(body.remotePending).toMatchObject({ provider: 'gitlab', namespace: ROOT });
    expect((await mockPaths()).filter((p) => p.startsWith('research/latex-archive/'))).toEqual([]);
    expect((await summary(request, body.id)).name).toBe('Sneaky');
  });
});
