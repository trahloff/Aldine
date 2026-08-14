import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

test.describe('v0.2 features', () => {
  test('template gallery creates a compiling project', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('new-project-name').fill('From Beamer');
    await expect(page.getByTestId('template-grid')).toBeVisible();
    await page.getByTestId('template-beamer').click();
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('editor-shell')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('documentclass', { timeout: 15_000 });
    await expect(page.locator('.cm-content')).toContainText('beamer');
  });

  test('word count updates live', async ({ page, request }) => {
    const id = await createProject(request, 'Word Count');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('word-count')).toBeVisible();
      await page.locator('.cm-content').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' alpha beta gamma delta epsilon');
      await expect(page.getByTestId('word-count')).toContainText(/\d+ words/, { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('drag-drop / picker upload adds a binary file', async ({ page, request }) => {
    const id = await createProject(request, 'Upload Test');
    try {
      await openProject(page, id);
      // 1x1 transparent PNG
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      await page.getByTestId('upload-input').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: png });
      await expect(page.getByTestId('file-figure.png')).toBeVisible({ timeout: 10_000 });
      // and it is retrievable
      const res = await request.get(`/api/projects/${id}/file?branch=main&path=figure.png`);
      expect(res.ok()).toBeTruthy();
    } finally {
      await cleanup(request, id);
    }
  });

  test('auto-typeset compiles after idle without pressing Typeset', async ({ page, request }) => {
    const id = await createProject(request, 'Auto Typeset');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('auto-toggle')).toHaveClass(/auto-toggle--on/);
      await page.locator('.cm-content').click();
      await page.keyboard.type(' \\par More text. ');
      // no Cmd+S — auto should fire (~2s debounce)
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 60_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('error log viewer opens', async ({ page, request }) => {
    const id = await createProject(request, 'Log Viewer');
    try {
      // break it
      const res = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
      const broken = (await res.text()).replace('\\section{Introduction}', '\\undefinedcmd');
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: broken } });
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('errors-panel')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('view-log').click();
      await expect(page.getByTestId('log-view')).toContainText(/Undefined control sequence|undefinedcmd/i);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('DOI / arXiv citation (references plugin)', () => {
  test('add a reference by DOI and insert the cite', async ({ page, request }) => {
    const id = await createProject(request, 'DOI Cite');
    try {
      await openProject(page, id);
      const tab = page.getByTestId('tab-plugin:references');
      await expect(tab).toBeVisible({ timeout: 15_000 });
      await tab.click();
      await page.getByTestId('reference-query').fill('10.1145/mock.12345');
      await page.getByTestId('reference-add').click();
      // cite inserted into the editor
      await expect(page.locator('.cm-content')).toContainText('\\cite{doe2020}', { timeout: 15_000 });
      // entry landed in references.bib
      const bib = await request.get(`/api/projects/${id}/bib?branch=main`);
      const entries = await bib.json();
      expect(entries.some((e: { key: string }) => e.key === 'doe2020')).toBeTruthy();
      // the &amp; from upstream must be decoded + LaTeX-escaped (compile-safe),
      // never a bare & (an alignment tab that breaks the whole document)
      const raw = await (await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`)).text();
      expect(raw).toContain('\\&');
      expect(raw).not.toMatch(/(?<!\\)&/);
      expect(raw).not.toContain('&amp;');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('SyncTeX jump', () => {
  test('double-click in the PDF jumps to the source line', async ({ page, request }) => {
    const { createPaperProject } = await import('./helpers');
    const id = await createPaperProject(request, 'SyncTeX');
    try {
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 120_000 });
      // cursor starts at line 1; double-click well into the first page body
      const canvas = page.locator('canvas.pdf-page').first();
      const box = await canvas.boundingBox();
      await page.mouse.dblclick(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55);
      // editor gains focus and scrolls to the mapped source location (not line 1)
      await expect(page.locator('.cm-content')).toBeFocused({ timeout: 10_000 });
      await expect.poll(async () => {
        const nums = await page.locator('.cm-gutterElement').allTextContents();
        const lines = nums.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        return lines.length ? Math.max(...lines) : 0;
      }, { timeout: 10_000 }).toBeGreaterThan(10);
    } finally {
      await cleanup(request, id);
    }
  });

  test('inverse jump opens the included chapter file, not the root', async ({ page, request }) => {
    // Root file in a subdirectory (paper/main.tex): SyncTeX reports inputs as
    // the compile dir + TeX's own path (…/paper/./chapters/…) — the jump must
    // still resolve to the project-relative file and switch the editor to it.
    const id = await createProject(request, 'SyncTeX nested');
    const chapter = [
      '\\section{Chapter one}',
      ...Array.from({ length: 12 }, (_, i) => `Chapter paragraph ${i + 1} with enough text to fill a line on the page.\n`),
    ].join('\n');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}\nIntro line in the root file.\n\\input{chapters/ch1}\n\\end{document}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/chapters/ch1.tex', content: chapter } });
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'paper/main.tex' } });
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 120_000 });
      const box = await page.locator('canvas.pdf-page').first().boundingBox();
      // mid-page is deep inside the chapter's paragraphs (the root contributes one line)
      await page.mouse.dblclick(box!.x + box!.width * 0.5, box!.y + box!.height * 0.45);
      await expect(page.locator('.cm-content')).toContainText('Chapter paragraph', { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('cite-from-search (OpenAlex)', () => {
  test('search papers, click a result, insert the cite', async ({ page, request }) => {
    const id = await createProject(request, 'Search Cite');
    try {
      await openProject(page, id);
      await page.getByTestId('tab-plugin:references').click();
      await page.getByTestId('reference-search').fill('mock searchable paper');
      // results render from the mock OpenAlex
      await expect(page.getByTestId('search-hit-W111')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('references-panel')).toContainText('A Searchable Mock Paper');
      await page.getByTestId('search-hit-W111').click();
      // a \cite is inserted and the entry lands in the .bib
      await expect(page.locator('.cm-content')).toContainText('\\cite{', { timeout: 15_000 });
      const bib = await (await request.get(`/api/projects/${id}/bib?branch=main`)).json();
      expect(bib.length).toBeGreaterThan(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a DOI-less result synthesizes a bib entry from metadata', async ({ page, request }) => {
    const id = await createProject(request, 'Search Cite 2');
    try {
      await openProject(page, id);
      await page.getByTestId('tab-plugin:references').click();
      await page.getByTestId('reference-search').fill('doi-less mock');
      await page.getByTestId('search-hit-W222').click();
      await expect(page.locator('.cm-content')).toContainText('\\cite{smith2019}', { timeout: 15_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});
