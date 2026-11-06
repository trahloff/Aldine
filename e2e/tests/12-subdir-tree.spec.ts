import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

test.describe('nested repos', () => {
  test('file tree renders directories and nested files', async ({ page, request }) => {
    const id = await createProject(request, 'Nested Tree');
    try {
      for (const [p, c] of Object.entries({
        'paper/main.tex': '\\documentclass{article}\\begin{document}x\\end{document}\n',
        'paper/chapters/intro.tex': 'Intro.\n',
        'figs/a.tex': 'fig\n',
      })) await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: p, content: c } });
      await openProject(page, id);
      // folders start closed (#249)
      await expect(page.getByTestId('dir-paper')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('dir-figs')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('dir-paper/chapters')).toHaveCount(0);
      await page.getByTestId('dir-paper').click();
      await page.getByTestId('dir-paper/chapters').click();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toBeVisible();
      await expect(page.getByTestId('file-figs/a.tex')).toHaveCount(0);
      // the open folders stay open on another sidebar tab and after a reload
      await page.getByTestId('tab-search').click();
      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toBeVisible();
      // collapse a folder → its child hides
      await page.getByTestId('dir-paper/chapters').click();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('the open file is revealed in a closed folder', async ({ page, request }) => {
    const id = await createProject(request, 'Reveal Tree');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/main.tex', content: '\\documentclass{article}\\begin{document}\\input{chapters/intro}\\end{document}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/chapters/intro.tex', content: 'An introduction.\n' } });
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'paper/main.tex' } });
      await openProject(page, id);
      await expect(page.getByTestId('file-paper/main.tex')).toHaveClass(/tree__item--active/);
      await expect(page.getByTestId('dir-paper/chapters')).toHaveAttribute('aria-expanded', 'false');
      // a file opened from outside the tree opens the folders above it
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('introduction');
      await page.locator('[data-testid="search-match"][data-path="paper/chapters/intro.tex"]').first().click();
      await expect(page.getByTestId('active-file')).toHaveText('paper/chapters/intro.tex');
      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toHaveClass(/tree__item--active/);
      // closed around the open file, it stays closed on another tab and after a reload
      await page.getByTestId('dir-paper/chapters').click();
      await page.getByTestId('tab-search').click();
      await page.getByTestId('tab-files').click();
      await expect(page.getByTestId('dir-paper/chapters')).toHaveAttribute('aria-expanded', 'false');
      await page.reload();
      await expect(page.getByTestId('dir-paper/chapters')).toHaveAttribute('aria-expanded', 'false', { timeout: 15_000 });
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a project opened straight from another shows its own tree, and going back shows the first one\'s', async ({ page, request }) => {
    const name = `Tree Of The First ${Date.now()}`;
    const id = await createProject(request, name);
    let copy = '';
    try {
      for (const p of ['paper/main.tex', 'paper/chapters/intro.tex', 'Makefile'])
        await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: p, content: 'x\n' } });
      await openProject(page, id);
      await page.getByTestId('dir-paper').click();
      await page.getByTestId('dir-paper/chapters').click();
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toBeVisible();
      await expect(page.getByTestId('file-Makefile')).toBeVisible();

      // the copy has the same folders, opened from the palette without a reload
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('Make a copy');
      await page.getByTestId('palette-item-make-copy').click();
      await page.locator('.toast', { hasText: `Made a copy: “${name} copy”` }).getByTestId('copy-open').click();
      await expect(page.getByTestId('project-name')).toHaveText(`${name} copy`);
      copy = new URL(page.url()).pathname.split('/').pop()!;
      expect(copy).not.toBe(id);
      await expect(page.getByTestId('dir-paper')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('file-Makefile')).toHaveCount(0);

      // back in the first project, its folders and its All view are as it left them
      await page.goBack();
      await expect(page.getByTestId('project-name')).toHaveText(name);
      await expect(page.getByTestId('file-paper/chapters/intro.tex')).toBeVisible();
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'false');
      // and the copy kept nothing of them
      await page.goForward();
      await expect(page.getByTestId('project-name')).toHaveText(`${name} copy`);
      await expect(page.getByTestId('dir-paper')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('source-only')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await cleanup(request, id);
      if (copy) await cleanup(request, copy);
    }
  });

  test('a root file in a subdirectory compiles (latexmk -cd)', async ({ page, request }) => {
    const id = await createProject(request, 'Subdir Root');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'book/main.tex',
        content: '\\documentclass{article}\\begin{document}\\input{sections/one}\\end{document}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'book/sections/one.tex', content: 'Hello from a subdir input.\n' } });
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'book/main.tex' } });
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 60_000 });
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 20_000 });
    } finally { await cleanup(request, id); }
  });
});

test.describe('editor layout', () => {
  test('a long document does not push the page past the viewport', async ({ page, request }) => {
    const id = await createProject(request, 'Long Doc');
    try {
      const long = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of a very long document.`).join('\n');
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: long } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('Line 1', { timeout: 10_000 });
      // the page itself must not scroll — the editor scrolls internally
      const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      expect(overflow).toBeLessThanOrEqual(2);
      await expect(page.getByTestId('typeset-button')).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});

test.describe('file tree clutter', () => {
  test('dot-dirs collapse by default and source-only hides non-source', async ({ page, request }) => {
    const id = await createProject(request, 'Clutter');
    try {
      for (const p of ['paper/main.tex', '.github/workflows/ci.yml', 'Makefile', 'README.md'])
        await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: p, content: 'x\n' } });
      await openProject(page, id);
      // source-only is the default view: Makefile hidden, and .github is
      // pruned entirely (it contains no source files)
      await expect(page.getByTestId('dir-paper')).toBeVisible();
      await expect(page.getByTestId('file-Makefile')).toHaveCount(0);
      await expect(page.getByTestId('dir-.github')).toHaveCount(0);
      // switch to All: non-source files appear…
      await page.getByTestId('source-only').click();
      await expect(page.getByTestId('file-Makefile')).toBeVisible();
      await expect(page.getByTestId('dir-.github')).toBeVisible();
      // …but dot-dirs still start collapsed → the nested file is not shown
      await expect(page.getByTestId('file-.github/workflows/ci.yml')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });
});

test.describe('file guards (QA regressions)', () => {
  test('create/rename onto an existing name never destroys the file', async ({ request }) => {
    const id = await createProject(request, 'Guards');
    try {
      const before = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(before.length).toBeGreaterThan(0);
      // createOnly onto an existing file → 409, file untouched
      const c = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: '', createOnly: true } });
      expect(c.status()).toBe(409);
      // rename onto an existing file → 409, both files untouched
      const r = await request.post(`/api/projects/${id}/file/rename`, { data: { branch: 'main', from: 'references.bib', to: 'main.tex' } });
      expect(r.status()).toBe(409);
      const after = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(after).toBe(before);
      const bib = await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`);
      expect(bib.ok()).toBeTruthy();
    } finally {
      await cleanup(request, id);
    }
  });

  test('deleting the typeset root reassigns rootFile to another .tex', async ({ request }) => {
    const id = await createProject(request, 'Root Reassign');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'other.tex', content: '\\documentclass{article}\\begin{document}y\\end{document}\n' } });
      const del = await request.delete(`/api/projects/${id}/file?branch=main&path=main.tex`);
      expect((await del.json()).newRoot).toBe('other.tex');
    } finally {
      await cleanup(request, id);
    }
  });
});
