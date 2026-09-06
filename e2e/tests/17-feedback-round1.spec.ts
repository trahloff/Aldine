import { test, expect } from '../fixtures';
import { createProject, createPaperProject, openProject, cleanup, buildZip, expectTypesetOk } from './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Auto-typeset (on by default) compiles on open; tests that count compile
 *  responses or need an untypeset project turn it off before the page loads. */
async function withoutAutoTypeset(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
}

async function engineOf(request: import('@playwright/test').APIRequestContext, id: string): Promise<string> {
  return (await (await request.get(`/api/projects/${id}`)).json()).engine;
}

test.describe('engine picker', () => {
  test('the preview select and the palette both persist the engine', async ({ page, request }) => {
    const id = await createProject(request, 'Engine Picker');
    try {
      await openProject(page, id);
      const sel = page.getByTestId('engine-select');
      await expect(sel).toHaveValue('pdf');
      await sel.selectOption('xelatex');
      await expect.poll(() => engineOf(request, id)).toBe('xelatex');
      await expect(sel).toHaveValue('xelatex');

      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('palette-input').fill('Typeset with LuaLaTeX');
      await page.getByTestId('palette-item-engine-lualatex').click();
      await expect.poll(() => engineOf(request, id)).toBe('lualatex');
      await expect(sel).toHaveValue('lualatex');

      // the value survives a reload — it is project meta, not UI state
      await page.reload();
      await expect(page.getByTestId('engine-select')).toHaveValue('lualatex');
    } finally { await cleanup(request, id); }
  });

  test('the server refuses an engine it cannot run', async ({ request }) => {
    const id = await createProject(request, 'Engine Reject');
    try {
      const res = await request.patch(`/api/projects/${id}`, { data: { engine: 'latex' } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain('Unknown engine');
      expect(await engineOf(request, id)).toBe('pdf');
    } finally { await cleanup(request, id); }
  });
});

test.describe('forward SyncTeX', () => {
  test('jump to PDF from a section file under a sub-directory root', async ({ page, request }) => {
    const id = await createProject(request, 'Jump Nested');
    const section = ['\\section{Section A}', ...Array.from({ length: 12 }, (_, i) => `Section paragraph ${i + 1} with enough text to fill a line.\n`)].join('\n');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/main.tex',
        content: '\\documentclass{article}\n\\begin{document}\nIntro.\n\\input{sections/a}\n\\end{document}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'paper/sections/a.tex', content: section } });
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'paper/main.tex' } });
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);

      await page.getByTestId('file-paper/sections/a.tex').click();
      await expect(page.locator('.cm-content')).toContainText('Section paragraph');
      await page.locator('.cm-line').nth(6).click();
      await page.getByTestId('jump-to-pdf').click();
      await expect(page.locator('.pdf-flash')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.pdf-flash')).toHaveCount(0, { timeout: 10_000 });

      // the shortcut works outside the editor too (window handler, not CodeMirror)
      await page.getByTestId('pdf-pane').click();
      await page.keyboard.press(`${mod}+j`);
      await expect(page.locator('.pdf-flash')).toBeVisible({ timeout: 10_000 });
    } finally { await cleanup(request, id); }
  });

  test('jumping before any typeset says so instead of failing silently', async ({ page, request }) => {
    const id = await createProject(request, 'Jump Untypeset');
    try {
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.getByTestId('jump-to-pdf').click();
      await expect(page.locator('.toast').filter({ hasText: /typeset first|Jump unavailable/ })).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('the shortcut is left alone while typing in another text field', async ({ page, request }) => {
    const id = await createProject(request, 'Jump Field Guard');
    const jumpToast = page.locator('.toast').filter({ hasText: /typeset first|Jump unavailable/ });
    try {
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.keyboard.press(`${mod}+k`);
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.press(`${mod}+j`);
      await page.waitForTimeout(800);
      await expect(jumpToast).toHaveCount(0);
      await page.keyboard.press('Escape');

      // positive control: from the PDF pane the same keystroke still jumps
      await page.getByTestId('pdf-pane').click();
      await page.keyboard.press(`${mod}+j`);
      await expect(jumpToast).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});

const compileResponse = (page: import('@playwright/test').Page) =>
  page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST');

test.describe('compile to completion', () => {
  test('an error mid-document still yields a complete PDF, listed beside it; stop-on-first-error restores the old behaviour', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Run To End');
    try {
      await withoutAutoTypeset(page);
      await openProject(page, id);

      const first = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const ok = await (await first).json();
      expect(ok.ok).toBe(true);
      await expectTypesetOk(page);
      const pagesBefore = await page.locator('canvas.pdf-page').count();

      // typesetting an unchanged document is not a failure and not stale:
      // latexmk rewrites nothing, the PDF keeps its link
      const again = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const unchanged = await (await again).json();
      expect(unchanged.ok).toBe(true);
      expect(unchanged.pdfStale).toBeFalsy();
      expect(unchanged.pdfUrl).toBe(ok.pdfUrl);
      await expectTypesetOk(page);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);

      // an undefined macro inside the second section: TeX reports it and carries on
      const content = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex',
        content: content.replace('\\section{Convergence}', '\\section{Convergence}\n\\thisMacroDoesNotExist\n') } });
      const second = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const withErrors = await (await second).json();
      expect(withErrors.ok).toBe(false);
      expect(withErrors.pdfStale).toBeFalsy();
      expect(withErrors.pdfUrl).not.toBe(ok.pdfUrl);
      expect(withErrors.errors.some((e: { message: string }) => /undefined control sequence/i.test(e.message))).toBe(true);

      await expect(page.getByTestId('errors-panel')).toBeVisible();
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);
      await expect.poll(() => page.locator('canvas.pdf-page').count()).toBe(pagesBefore);

      // a jump from the current PDF resolves against this run's SyncTeX
      const box = await page.locator('canvas.pdf-page').first().boundingBox();
      await page.mouse.dblclick(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55);
      await expect(page.locator('.toast').filter({ hasText: /last successful typeset|different runs|unavailable/ })).toHaveCount(0);

      // the toggle lives in the log dialog and is project meta
      await page.getByTestId('view-log').click();
      await page.getByTestId('stop-on-error-toggle').check();
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}`)).json()).stopOnFirstError).toBe(true);
      await page.keyboard.press('Escape');

      const third = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const halted = await (await third).json();
      expect(halted.ok).toBe(false);
      expect(halted.pdfStale).toBe(true);
      expect(halted.pdfUrl).toBe(withErrors.pdfUrl);
      await expect(page.getByTestId('pdf-stale')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('a document with a bibliography resolves its citations even when a pass fails', async ({ page, request }) => {
    const id = await createProject(request, 'Run To End Bib');
    try {
      // Every real paper has a bibliography, and running to completion is what
      // gets it: latexmk stops after a failed pass unless forced, so bibtex and
      // the reruns never happen and each \cite renders as [?].
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib',
        content: '@article{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {Literate Programming},\n  journal = {The Computer Journal},\n  year = {1984},\n}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Intro}\\label{sec:intro}',
        'Literate programming \\cite{knuth1984} and \\ref{sec:intro}.',
        '\\thisMacroDoesNotExist',
        '\\bibliographystyle{plain}',
        '\\bibliography{refs}',
        '\\end{document}',
        '' ].join('\n') } });

      await withoutAutoTypeset(page);
      await openProject(page, id);
      const first = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const result = await (await first).json();

      expect(result.ok).toBe(false);
      expect(result.pdfUrl).toBeTruthy();
      expect(result.errors.some((e: { message: string }) => /undefined control sequence/i.test(e.message))).toBe(true);
      // the point of the test: the failed pass did not cost the bibliography
      expect(result.log).not.toMatch(/Citation `knuth1984' .* undefined/);
      expect(result.log).not.toMatch(/Reference `sec:intro' .* undefined/);
      expect(result.log).toMatch(/Output written on/);
    } finally { await cleanup(request, id); }
  });

  test('a broken .bib entry is reported with its line instead of a wall of undefined citations', async ({ page, request }) => {
    const id = await createProject(request, 'Broken Bib');
    try {
      // A missing closing brace: bibtex writes no usable .bbl, so the LaTeX log
      // carries only "Citation undefined" — the line to fix is in the .blg.
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib',
        content: '@article{a,\n  title = {One},\n  year = {2001},\n\n@article{b,\n  title = {Two},\n  year = {2002},\n}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: [
        '\\documentclass{article}',
        '\\begin{document}',
        'Text \\cite{a} and \\cite{b}.',
        '\\bibliographystyle{plain}',
        '\\bibliography{refs}',
        '\\end{document}',
        '' ].join('\n') } });

      await withoutAutoTypeset(page);
      await openProject(page, id);
      const first = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const result = await (await first).json();

      const bib = result.errors.filter((e: { type: string; file?: string }) => e.type === 'error' && e.file === 'refs.bib');
      expect(bib.length).toBeGreaterThan(0);
      expect(bib[0].line).toBeGreaterThan(1);
      expect(bib[0].message).toMatch(/^BibTeX: /);
      // the row is a link into refs.bib, not a dead end
      await expect(page.getByTestId('errors-panel')).toBeVisible();
      await page.getByTestId('errors-panel').getByText(/BibTeX: /).first().click();
      await expect(page.getByTestId('active-file')).toHaveText('refs.bib');
    } finally { await cleanup(request, id); }
  });
});

test.describe('stale preview', () => {
  test('a failed typeset keeps the PDF, flags it, and clears once it compiles again', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Stale Preview');
    // this test is about the halting mode; the default now runs to the end
    expect((await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } })).ok()).toBeTruthy();
    try {
      // an on-open compile would be the response the first wait matches
      await withoutAutoTypeset(page);
      await openProject(page, id);

      const first = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const ok = await (await first).json();
      expect(ok.ok).toBe(true);
      await expectTypesetOk(page);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);

      const content = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex',
        content: content.replace('\\begin{document}', '\\begin{document}\n\\begin{itemize}\n') } });
      const second = compileResponse(page);
      await page.getByTestId('typeset-button').click();
      const failed = await (await second).json();
      expect(failed.ok).toBe(false);
      expect(failed.pdfStale).toBe(true);
      // pdfTeX removes the PDF of a halted run once a page has shipped out,
      // so the link is gone; the pages on screen stay, flagged.
      expect([null, ok.pdfUrl]).toContain(failed.pdfUrl);

      await expect(page.getByTestId('pdf-stale')).toBeVisible();
      await expect(page.getByTestId('pdf-stale')).toContainText('last successful typeset');
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible();
      const box = await page.locator('canvas.pdf-page').first().boundingBox();
      await page.mouse.dblclick(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55);
      await expect(page.locator('.toast').filter({ hasText: 'last successful typeset' })).toBeVisible();

      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('switching branches empties the preview so a failure there cannot claim the other branch\'s PDF', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Stale Branch');
    // halting mode: these tests are about a run that leaves no PDF to show
    expect((await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } })).ok()).toBeTruthy();
    try {
      await withoutAutoTypeset(page);
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);

      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-draft').click();
      await expect(page).toHaveURL(/branch=draft/);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(0);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);

      const content = await (await request.get(`/api/projects/${id}/file?branch=draft&path=main.tex`)).text();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'draft', path: 'main.tex',
        content: content.replace('\\begin{document}', '\\begin{document}\n\\begin{itemize}\n') } });
      const failed = page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST');
      await page.getByTestId('typeset-button').click();
      const body = await (await failed).json();
      expect(body.ok).toBe(false);
      expect(body.pdfUrl).toBeNull();
      await expect(page.getByTestId('pdf-status')).toContainText(/fail|error/i);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(0);
      await expect(page.getByTestId('pdf-stale')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a recreated branch does not inherit the deleted branch\'s PDF', async ({ request }) => {
    const id = await createPaperProject(request, 'Stale Recreated');
    // halting mode: these tests are about a run that leaves no PDF to show
    expect((await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } })).ok()).toBeTruthy();
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      const ok = await (await request.post(`/api/projects/${id}/compile`, { data: { branch: 'draft' } })).json();
      expect(ok.ok).toBe(true);
      expect(typeof ok.pdfUrl).toBe('string');

      expect((await request.delete(`/api/projects/${id}/branches?name=draft`)).ok()).toBe(true);
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      const content = await (await request.get(`/api/projects/${id}/file?branch=draft&path=main.tex`)).text();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'draft', path: 'main.tex',
        content: content.replace('\\begin{document}', '\\begin{document}\n\\begin{itemize}\n') } });
      const failed = await (await request.post(`/api/projects/${id}/compile`, { data: { branch: 'draft' } })).json();
      expect(failed.ok).toBe(false);
      expect(failed.pdfUrl).toBeNull();
      expect(failed.pdfStale).toBe(false);
    } finally { await cleanup(request, id); }
  });
});

test.describe('ZIP import root detection and path safety', () => {
  const tmpZip = (name: string, entries: Record<string, Buffer | string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-r1-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, buildZip(entries));
    return { dir, file };
  };

  test('a long comment banner and a bigger sample.tex do not hide the manuscript', async ({ page, request }) => {
    // 5 KB of `%` banner before \documentclass, like a journal template ships
    const banner = Array.from({ length: 80 }, (_, i) => `% Journal template banner line ${i + 1}: do not remove, see the guide for authors.`).join('\n');
    expect(banner.length).toBeGreaterThan(4096);
    const manuscript = `${banner}\n\\documentclass{article}\n\\begin{document}\nBANNER-MANUSCRIPT\n\\end{document}\n`;
    const sample = `\\documentclass{article}\n\\begin{document}\n${'Sample text that outsizes the manuscript.\n'.repeat(400)}\\end{document}\n`;
    expect(sample.length).toBeGreaterThan(manuscript.length);
    const name = `banner-${Date.now()}`;
    const { dir, file } = tmpZip(`${name}.zip`, { 'submission.tex': manuscript, 'sample.tex': sample, 'refs.bib': '' });
    let id: string | null = null;
    try {
      await page.goto('/');
      await page.getByTestId('import-input').setInputFiles(file);
      await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
      id = new URL(page.url()).pathname.split('/')[2];
      const meta = await (await request.get(`/api/projects/${id}`)).json();
      expect(meta.rootFile).toBe('submission.tex');
      await expect(page.locator('.tree__item--active')).toContainText('submission.tex');
      await expect(page.locator('.cm-line').first()).toContainText('Journal template banner line 1');
    } finally {
      if (id) await cleanup(request, id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an entry escaping the project is refused and leaves no project behind', async ({ page, request }) => {
    const name = `bad-path-${Date.now()}`;
    const { dir, file } = tmpZip(`${name}.zip`, {
      'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}',
      '../escape.tex': 'outside',
    });
    try {
      await page.goto('/');
      await page.getByTestId('import-input').setInputFiles(file);
      await expect(page.locator('.toast').filter({ hasText: 'points outside the project' })).toBeVisible();
      await expect(page.getByTestId('editor-shell')).toHaveCount(0);
      const list = await (await request.get('/api/projects')).json();
      expect(list.some((p: { name: string }) => p.name === name)).toBe(false);
      await page.reload();
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
      await expect(page.getByText(name)).toHaveCount(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
