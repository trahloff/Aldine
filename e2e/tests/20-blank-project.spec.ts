import { test, expect } from '../fixtures';
import { openProject, cleanup, expectTypesetOk, typeAtEnd } from './helpers';

/**
 * Blank projects (issue #8): a project with no files, no typeset root, no
 * compile until the first .tex exists.
 */

async function createBlank(request: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/projects', { data: { name, template: 'blank' } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

async function userFiles(request: import('@playwright/test').APIRequestContext, id: string): Promise<string[]> {
  const { files: list } = await (await request.get(`/api/projects/${id}/files`)).json() as { files: { path: string; type: string }[] };
  return list.filter((f) => f.type === 'file' && f.path !== '.gitignore').map((f) => f.path).sort();
}

async function rootOf(request: import('@playwright/test').APIRequestContext, id: string): Promise<string> {
  return (await (await request.get(`/api/projects/${id}`)).json()).rootFile;
}

test.describe('blank project', () => {
  test('the Blank tile creates a project with zero files and opens to the empty state without typesetting', async ({ page, request }) => {
    const compiles: string[] = [];
    page.on('request', (r) => { if (/\/api\/projects\/[^/]+\/compile$/.test(r.url())) compiles.push(r.url()); });

    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('Blank E2E');
    const grid = page.getByTestId('template-grid');
    await expect(grid).toBeVisible();
    // Blank leads the grid
    await expect(grid.locator('button').first()).toHaveAttribute('data-testid', 'template-blank');
    await page.getByTestId('template-blank').click();
    await page.getByTestId('create-project').click();
    await page.waitForURL(/\/p\//);
    const id = page.url().split('/p/')[1].split(/[?#]/)[0];
    try {
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      const empty = page.getByTestId('empty-project');
      await expect(empty).toContainText('Create a file to start writing');
      await expect(page.getByTestId('empty-new-file')).toBeVisible();
      // the PDF pane must not invite the keystroke that fails on a blank project
      await expect(page.getByTestId('pdf-empty-no-tex')).toContainText('Create a .tex file to typeset and preview.');

      expect(await userFiles(request, id)).toEqual([]);
      expect(await rootOf(request, id)).toBe('');

      // give an on-open auto-typeset every chance to fire, then assert it did not
      await page.waitForTimeout(2500);
      expect(compiles).toEqual([]);
      await expect(page.getByText(/Typesetting failed/)).toHaveCount(0);
      await expect(page.getByTestId('pdf-status')).not.toContainText('Failed');
    } finally { await cleanup(request, id); }
  });

  test('the first .tex created becomes the root and the project typesets on the next idle', async ({ page, request }) => {
    const id = await createBlank(request, 'Blank First Tex');
    try {
      await page.goto(`/p/${id}`);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await page.getByTestId('empty-new-file').click();
      const name = page.getByTestId('new-file-name');
      await expect(name).toBeVisible();
      await expect(name).toHaveValue('main.tex');
      // The request is one-shot: dismissing it and remounting the tree (any
      // other sidebar tab unmounts it) must not reopen the input, which would
      // create main.tex on the next blur.
      await name.press('Escape');
      await expect(name).toHaveCount(0);
      await page.getByTestId('tab-history').click();
      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('file-tree')).toBeVisible();
      await expect(name).toHaveCount(0);
      expect(await userFiles(request, id)).toEqual([]);

      await page.getByTestId('empty-new-file').click();
      await expect(name).toBeVisible();
      await expect(name).toHaveValue('main.tex');
      await name.press('Enter');

      await expect(page.getByTestId('file-main.tex')).toBeVisible();
      await expect(page.locator('.cm-content')).toBeVisible();
      await expect(page.getByTestId('empty-project')).toHaveCount(0);
      await expect.poll(() => rootOf(request, id)).toBe('main.tex');

      // Content arrives through the file API (a remote edit to this client);
      // the local keystroke that follows is what auto-typeset reacts to.
      const doc = '\\documentclass{article}\n\\begin{document}\nHello from a blank project.\n\\end{document}\n';
      const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } });
      expect(res.ok()).toBeTruthy();
      await expect(page.locator('.cm-content')).toContainText('Hello from a blank project');
      await typeAtEnd(page, '% idle');
      await expectTypesetOk(page);
    } finally { await cleanup(request, id); }
  });

  test('the API refuses to typeset a project with no .tex and adopts the first one written', async ({ request }) => {
    const res = await request.post('/api/projects', { data: { name: 'Blank API', files: {} } });
    expect(res.ok()).toBeTruthy();
    const id = (await res.json()).id as string;
    try {
      expect(await userFiles(request, id)).toEqual([]);
      const failed = await request.post(`/api/projects/${id}/compile`, { data: { branch: 'main' } });
      expect(failed.status()).toBe(400);
      expect((await failed.json()).error).toContain('No .tex file');

      const put = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'notes/draft.tex', content: '\\documentclass{article}\\begin{document}Draft\\end{document}', createOnly: true } });
      expect(await put.json()).toEqual({ ok: true, newRoot: 'notes/draft.tex' });
      expect(await rootOf(request, id)).toBe('notes/draft.tex');
    } finally { await cleanup(request, id); }
  });

  test('the API refuses seed files that reach .git and leaves nothing behind', async ({ request }) => {
    const before = ((await (await request.get('/api/projects')).json()) as { id: string }[]).map((p) => p.id).sort();
    for (const files of [
      { 'main.tex': 'x', '.git/config': '[core]\n\tfsmonitor = true\n' },
      { '.git/hooks/pre-commit': '#!/bin/sh' },
      { '': 'x' },
      { 'main.tex': 1 },
      { a: 'x', 'a/b': 'y' },
    ]) {
      const res = await request.post('/api/projects', { data: { name: 'Bad seed', files } });
      expect(res.status(), JSON.stringify(files)).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    const after = ((await (await request.get('/api/projects')).json()) as { id: string }[]).map((p) => p.id).sort();
    expect(after).toEqual(before);
  });
});
