import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

/** A chapter long enough to scroll: one numbered sentence per line. */
const chapter = (name: string, lines = 300) =>
  Array.from({ length: lines }, (_, i) => `Line ${i + 1} of chapter ${name} says something worth reading.`).join('\n') + '\n';

async function put(request: APIRequestContext, id: string, path: string, content: string, branch = 'main') {
  const res = await request.put(`/api/projects/${id}/file`, { data: { branch, path, content } });
  expect(res.ok()).toBeTruthy();
}

async function openFile(page: Page, path: string, text: string) {
  await page.getByTestId(`file-${path}`).click();
  await expect(page.getByTestId('active-file')).toHaveText(path);
  await expect(page.locator('.cm-content')).toContainText(text);
}

/** The line at the top edge of the editor and how far its top sits from
 *  that edge. scrollTop itself is no measure: a new editor estimates the
 *  height of lines above the screen until it has drawn them. */
function topLine(page: Page): Promise<{ text: string; offset: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('.cm-scroller')!.getBoundingClientRect();
    const left = document.querySelector('.cm-content')!.getBoundingClientRect().left;
    const line = document.elementFromPoint(left + 8, box.top + 2)!.closest('.cm-line')!;
    return { text: line.textContent ?? '', offset: Math.round(line.getBoundingClientRect().top - box.top) };
  });
}

/** Scrolls the editor well down, puts the caret on a line in the middle of
 *  the screen, and says which line that is and which line is at the top. */
async function leaveCaretMidway(page: Page): Promise<{ line: string; top: { text: string; offset: number } }> {
  const scroller = page.locator('.cm-scroller');
  await scroller.evaluate((el) => { el.scrollTop = 2600; });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(2000);
  const box = (await scroller.boundingBox())!;
  await page.mouse.click(box.x + 260, box.y + box.height / 2);
  const line = await page.locator('.cm-activeLine').innerText();
  expect(line).toMatch(/^Line (\d+) of chapter A/);
  expect(Number(/^Line (\d+)/.exec(line)![1])).toBeGreaterThan(60);
  const top = await topLine(page);
  expect(top.text).toMatch(/^Line (\d+) of chapter A/);
  return { line, top };
}

async function expectTopLine(page: Page, top: { text: string; offset: number }, slack = 2) {
  await expect.poll(async () => (await topLine(page)).text).toBe(top.text);
  expect(Math.abs((await topLine(page)).offset - top.offset)).toBeLessThanOrEqual(slack);
}

/** Clicks a file in the tree and reads the editor at the next frame, before
 *  the browser paints the switch. */
function switchAndReadFirstFrame(page: Page, path: string): Promise<string> {
  return page.evaluate((path) => new Promise<string>((resolve) => {
    (document.querySelector(`[data-testid="file-${path}"]`) as HTMLElement).click();
    requestAnimationFrame(() => resolve(document.querySelector('.cm-content')?.textContent ?? ''));
  }), path);
}

test.describe('switching files', () => {
  test('a file switched back to shows at once, with the caret and scroll it was left with', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch');
    try {
      await put(request, id, 'a.tex', chapter('A'));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      const left = await leaveCaretMidway(page);

      await openFile(page, 'b.tex', 'Short file.');
      const first = await switchAndReadFirstFrame(page, 'a.tex');
      expect(first, 'the first frame after the switch already holds the file').toContain('of chapter A says');

      await expect(page.getByTestId('active-file')).toHaveText('a.tex');
      await expect(page.locator('.cm-activeLine')).toHaveText(left.line);
      await expectTopLine(page, left.top);

      // the caret is really there: typing lands on that line
      await page.locator('.cm-activeLine').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' RESUMED');
      await expect(page.locator('.cm-activeLine')).toHaveText(`${left.line} RESUMED`);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Undo reaches edits made before a switch and puts the caret back on them', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Undo');
    try {
      await put(request, id, 'a.tex', chapter('A', 40));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      await page.locator('.cm-line', { hasText: 'Line 3 of chapter A' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' TYPED-BEFORE');
      await expect(page.locator('.cm-content')).toContainText('TYPED-BEFORE');

      await openFile(page, 'b.tex', 'Short file.');
      await openFile(page, 'a.tex', 'TYPED-BEFORE');
      // the caret goes elsewhere first, so the undo has to bring it back
      await page.locator('.cm-line', { hasText: 'Line 20 of chapter A' }).click();
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.locator('.cm-content')).not.toContainText('TYPED-BEFORE');
      await expect(page.locator('.cm-activeLine')).toHaveText(/^Line 3 of chapter A/);
      // Capital Z: a keyboard held with Shift reports key "Z", while
      // Playwright's "Shift+z" sends key "z" with shiftKey set. CodeMirror
      // looks that up as Mod-z first, and y-codemirror's Undo claims every
      // key it runs on, so off macOS the lowercase spelling never redoes.
      await page.keyboard.press('ControlOrMeta+Shift+Z');
      await expect(page.locator('.cm-line', { hasText: 'Line 3 of chapter A' })).toHaveText(/ TYPED-BEFORE$/);

      // and the other file's history stays its own
      await openFile(page, 'b.tex', 'Short file.');
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+z');
      await openFile(page, 'a.tex', 'TYPED-BEFORE');
    } finally {
      await cleanup(request, id);
    }
  });

  test('on Linux and Windows, Ctrl+Shift+Z redoes after a switch', async ({ page, request }) => {
    // CodeMirror reads the platform once, when it loads: the page has to
    // look like Linux before any script runs.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' });
      const ua = navigator.userAgent.replace(/\(Macintosh;[^)]*\)/, '(X11; Linux x86_64)');
      Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => ua });
    });
    const id = await createProject(request, 'File Switch Redo Linux');
    try {
      await put(request, id, 'a.tex', chapter('A', 40));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      await openProject(page, id);
      expect(await page.evaluate(() => navigator.platform)).toBe('Linux x86_64');
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      await page.locator('.cm-line', { hasText: 'Line 3 of chapter A' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' TYPED-BEFORE');
      await expect(page.locator('.cm-content')).toContainText('TYPED-BEFORE');

      await openFile(page, 'b.tex', 'Short file.');
      await openFile(page, 'a.tex', 'TYPED-BEFORE');
      await page.locator('.cm-line', { hasText: 'Line 20 of chapter A' }).click();
      await page.keyboard.press('Control+z');
      await expect(page.locator('.cm-content')).not.toContainText('TYPED-BEFORE');
      // capital Z, as a real keyboard sends it: see the test above
      await page.keyboard.press('Control+Shift+Z');
      await expect(page.locator('.cm-line', { hasText: 'Line 3 of chapter A' })).toHaveText(/ TYPED-BEFORE$/);
      await page.keyboard.press('Control+z');
      await expect(page.locator('.cm-content')).not.toContainText('TYPED-BEFORE');
      await page.keyboard.press('Control+y');
      await expect(page.locator('.cm-line', { hasText: 'Line 3 of chapter A' })).toHaveText(/ TYPED-BEFORE$/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a collaborator sees this person only in the file they have open', async ({ browser, request }) => {
    const id = await createProject(request, 'File Switch Presence');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await put(request, id, 'a.tex', chapter('A', 20));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await a.addInitScript(() => { localStorage.setItem('aldine.name', 'Ada'); localStorage.setItem('aldine.color', '#e8554d'); });
      await b.addInitScript(() => { localStorage.setItem('aldine.name', 'Bob'); localStorage.setItem('aldine.color', '#2e933c'); });
      await openProject(a, id);
      await openProject(b, id);
      await openFile(a, 'a.tex', 'Line 1 of chapter A');
      await openFile(b, 'a.tex', 'Line 1 of chapter A');
      const ada = b.getByTestId('presence').locator('[data-name="Ada"]');
      await expect(ada).toHaveAttribute('data-here', 'true');

      // The doc a.tex keeps for Ada carries no presence: she shows in b.tex only.
      await openFile(a, 'b.tex', 'Short file.');
      await expect(ada, 'Ada left a.tex').toHaveAttribute('data-here', 'false');
      await expect(ada).toHaveAttribute('data-file', 'b.tex');
      await expect(b.locator('.cm-ySelectionInfo', { hasText: 'Ada' }), 'and her caret left with her').toHaveCount(0);
      await openFile(a, 'a.tex', 'Line 1 of chapter A');
      await expect(ada).toHaveAttribute('data-here', 'true');
      await expect(a.getByTestId('presence').locator('[data-name="Bob"]')).toHaveAttribute('data-here', 'true');
    } finally {
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test('switching files keeps open only the connections of the files it keeps', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Sockets');
    try {
      const names = Array.from({ length: 8 }, (_, i) => `ch${i + 1}.tex`);
      for (const n of names) await put(request, id, n, `% ${n}\nText of ${n}.\n`);
      const open = new Set<object>();
      page.on('websocket', (ws) => { open.add(ws); ws.on('close', () => open.delete(ws)); });
      await openProject(page, id);
      // the open file, the five files left last (PARKED_MAX), and the files and comments signals
      const bound = 1 + 5 + 2;
      for (const n of names) await openFile(page, n, `Text of ${n}.`);
      await expect.poll(() => open.size).toBe(bound);
      for (const n of ['ch4.tex', 'ch8.tex', 'ch5.tex', 'ch7.tex', 'ch1.tex', 'ch2.tex', 'ch8.tex', 'ch3.tex']) await openFile(page, n, `Text of ${n}.`);
      await expect.poll(() => open.size).toBe(bound);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a file deleted elsewhere while this tab keeps it is not written back', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Delete');
    try {
      await put(request, id, 'a.tex', chapter('A', 20));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      await page.locator('.cm-content').click();
      await page.keyboard.type('EDITED ');
      await openFile(page, 'b.tex', 'Short file.');

      const del = await request.delete(`/api/projects/${id}/file?branch=main&path=a.tex`);
      expect(del.ok()).toBeTruthy();
      await expect(page.getByTestId('file-a.tex')).toHaveCount(0);
      // past the server's 5 s tombstone, when a reconnect would load it afresh
      await page.waitForTimeout(7000);
      const { files } = await (await request.get(`/api/projects/${id}/files?branch=main`)).json();
      expect(files.map((f: { path: string }) => f.path)).not.toContain('a.tex');
      await expect(page.getByTestId('file-a.tex')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a file a merge deletes stays deleted for a tab that keeps it', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Merge');
    try {
      await put(request, id, 'a.tex', chapter('A', 20));
      await put(request, id, 'b.tex', '% chapter B\nShort file.\n');
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'cleanup', from: 'main' } })).ok()).toBeTruthy();
      expect((await request.delete(`/api/projects/${id}/file?branch=cleanup&path=a.tex`)).ok()).toBeTruthy();
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      await openFile(page, 'b.tex', 'Short file.');

      const merged = await request.post(`/api/projects/${id}/merge`, { data: { from: 'cleanup', into: 'main' } });
      expect((await merged.json()).ok).toBe(true);
      await expect(page.getByTestId('file-a.tex')).toHaveCount(0);
      const { files } = await (await request.get(`/api/projects/${id}/files?branch=main`)).json();
      expect(files.map((f: { path: string }) => f.path)).not.toContain('a.tex');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the file open at a reload comes back with its caret and scroll', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Reload');
    try {
      await put(request, id, 'a.tex', chapter('A'));
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      const left = await leaveCaretMidway(page);

      await page.reload();
      await expect(page.getByTestId('active-file')).toHaveText('a.tex');
      await expect(page.locator('.cm-activeLine')).toHaveText(left.line);
      await expectTopLine(page, left.top);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a branch switched away from and back keeps the caret of its file', async ({ page, request }) => {
    const id = await createProject(request, 'File Switch Branch');
    try {
      await put(request, id, 'a.tex', chapter('A'));
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft', from: 'main' } })).ok()).toBeTruthy();
      await openProject(page, id);
      await openFile(page, 'a.tex', 'Line 1 of chapter A');
      const left = await leaveCaretMidway(page);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-draft').click();
      await expect(page.getByTestId('branch-menu')).toContainText('draft');
      await expect(page.getByTestId('active-file')).toBeVisible();
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-main').click();
      await expect(page.getByTestId('branch-menu')).toContainText('main');
      await expect(page.getByTestId('active-file')).toHaveText('a.tex');
      await expect(page.locator('.cm-activeLine')).toHaveText(left.line);
    } finally {
      await cleanup(request, id);
    }
  });
});
