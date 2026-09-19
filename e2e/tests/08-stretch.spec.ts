import { test, expect } from '../fixtures';
import { createProject, createPaperProject, openProject, cleanup, PAPER_DIR } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

test.describe('command palette', () => {
  test('Cmd+K opens palette and can open a file', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Test');
    try {
      await openProject(page, id);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await page.getByTestId('palette-input').fill('references.bib');
      await expect(page.getByTestId('palette-item-open-references.bib')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('command-palette')).not.toBeVisible();
      // the bib file is now the active file
      await expect(page.locator('.tree__item--active')).toContainText('references.bib');
    } finally {
      await cleanup(request, id);
    }
  });

  test('palette can insert an equation snippet', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Snippet');
    try {
      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('equation');
      await page.getByTestId('palette-item-snippet-eq').click();
      await expect(page.locator('.cm-content')).toContainText('\\begin{equation}');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('ZIP import', () => {
  test('import a project ZIP from the home page', async ({ page, request }) => {
    // build a small zip fixture
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-zip-'));
    fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{article}\\begin{document}ZIP-IMPORTED\\end{document}');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello');
    const zip = path.join(tmp, 'proj.zip');
    execSync(`cd ${tmp} && zip -q -r ${zip} main.tex notes.txt`);

    await page.goto('/');
    await page.getByTestId('import-input').setInputFiles(zip);
    await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('file-main.tex')).toBeVisible();
    // the tree starts in source-only view; switch to All to see notes.txt
    await page.getByTestId('source-only').click();
    await expect(page.getByTestId('file-notes.txt')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('ZIP-IMPORTED');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('import rejects .git/ entries (no config injection)', async ({ request }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-evil-'));
    fs.writeFileSync(path.join(tmp, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}');
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, '.git', 'config'), '[core]\n  evil = true');
    execSync(`cd ${tmp} && zip -q -r evil.zip main.tex .git`);
    const b64 = fs.readFileSync(path.join(tmp, 'evil.zip')).toString('base64');
    const res = await request.post('/api/projects/import', { data: { name: 'Evil', zipBase64: b64 } });
    expect(res.ok()).toBeTruthy();
    const { id } = await res.json();
    const { files } = await (await request.get(`/api/projects/${id}/files?branch=main`)).json();
    const paths = files.filter((f: { type: string }) => f.type === 'file').map((f: { path: string }) => f.path);
    expect(paths).toContain('main.tex');
    expect(paths.some((p: string) => p.startsWith('.git/'))).toBeFalsy();
    await request.delete(`/api/projects/${id}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test.describe('project-wide \\ref indexing', () => {
  test('\\ref completes labels from another file', async ({ page, request }) => {
    const id = await createProject(request, 'Ref Index');
    try {
      // add a second file with a label
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'sections.tex', content: '\\section{Method}\\label{sec:crossref}' } });
      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' \\ref{sec:cro');
      await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('sec:crossref', { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('deepened features', () => {
  test('hovering a \\cite shows the reference', async ({ page, request }) => {
    const id = await createProject(request, 'Cite Hover');
    try {
      // seed a bib entry and a document whose only body line is the cite
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'references.bib', content: '@article{smith2020,\n  author = {Smith, Jane},\n  title = {A Notable Paper},\n  year = {2020},\n}\n' } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'cite.tex', content: '\\cite{smith2020}\n' } });
      await openProject(page, id);
      await page.getByTestId('file-cite.tex').click();
      await expect(page.locator('.cm-content')).toContainText('smith2020', { timeout: 10_000 });
      await page.waitForTimeout(600); // let warmBib load
      // hover over the key (roughly char 6+ on the line: "\cite{smith2020}")
      const box = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.move(box!.x + 85, box!.y + box!.height / 2);
      await page.waitForTimeout(400);
      await page.mouse.move(box!.x + 86, box!.y + box!.height / 2);
      await expect(page.locator('.cm-tooltip')).toContainText('A Notable Paper', { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('palette can rename the active file', async ({ page, request }) => {
    const id = await createProject(request, 'Palette Rename');
    try {
      await openProject(page, id);
      page.on('dialog', (d) => d.accept('renamed.tex'));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('rename');
      await page.getByTestId('palette-item-rename-file').click();
      await expect(page.getByTestId('file-renamed.tex')).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});
