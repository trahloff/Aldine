import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup, expectTypesetOk } from './helpers';

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

/** Waits out the collab store debounce. */
const expectStored = (request: APIRequestContext, id: string, expected: string) =>
  expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(expected);

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });

/** The editor's text without collaborators' caret labels. */
const shownText = (page: Page) => page.evaluate(() => {
  const copy = document.querySelector('.cm-content')!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.cm-ySelectionCaret').forEach((e) => e.remove());
  return copy.textContent ?? '';
});

/** #188: Vim keybindings, a choice this browser remembers. */
test.describe('Vim keybindings', () => {
  test('turn on in settings, edit through Yjs with Vim undo, survive a reload and turn off', async ({ page, browser, request }) => {
    const id = await createProject(request, 'Vim Mode');
    const DOC = 'Hello world.\n';
    const peerContext = await browser.newContext();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expect(page.locator('.cm-vim-panel')).toHaveCount(0);

      await page.getByTestId('project-settings-open').click();
      const box = page.getByTestId('settings-vim');
      await expect(box).not.toBeChecked();
      await box.check();
      await expect(page.getByTestId('project-settings')).toContainText('Esc for normal mode');
      await page.getByTestId('settings-close').click();
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');

      // ihello<Esc>: i enters insert mode, the text goes in, Esc leaves it.
      await line(page, 'Hello world.').click();
      await page.keyboard.press('0');
      await page.keyboard.type('ihello ');
      await expect(page.locator('.cm-vim-panel')).toContainText('--INSERT--');
      await page.keyboard.press('Escape');
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');
      await expectStored(request, id, 'hello Hello world.\n');

      // A collaborator without Vim types meanwhile; u undoes only this
      // person's edit (the Yjs undo manager), Ctrl-R brings it back.
      const peer = await peerContext.newPage();
      await openProject(peer, id);
      await expect(peer.locator('.cm-vim-panel')).toHaveCount(0);
      await line(peer, 'Hello world.').click();
      await peer.keyboard.press('End');
      await peer.keyboard.type(' From a peer.');
      await expect(line(page, 'From a peer.')).toBeVisible();
      await page.locator('.cm-content').focus();
      await page.keyboard.press('u');
      await expectStored(request, id, 'Hello world. From a peer.\n');
      await page.keyboard.press('Control+r');
      await expectStored(request, id, 'hello Hello world. From a peer.\n');
      await expect.poll(() => shownText(peer)).toBe('hello Hello world. From a peer.');

      // The choice is this browser's: on after a reload, and from the palette off again.
      await page.reload();
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--', { timeout: 15_000 });
      expect(await page.evaluate(() => localStorage.getItem('aldine.vim'))).toBe('1');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('vim');
      await expect(page.getByTestId('palette-item-vim')).toHaveText(/Turn Vim keybindings off/);
      await page.getByTestId('palette-item-vim').click();
      await expect(page.locator('.cm-vim-panel')).toHaveCount(0);
      await line(page, 'From a peer.').click();
      await page.keyboard.press('End');
      await page.keyboard.type('ihello');
      await expectStored(request, id, 'hello Hello world. From a peer.ihello\n');
      expect(await page.evaluate(() => localStorage.getItem('aldine.vim'))).toBe('0');
    } finally {
      await peerContext.close();
      await page.evaluate(() => localStorage.removeItem('aldine.vim')).catch(() => {});
      await cleanup(request, id);
    }
  });

  test(':w typesets like Typeset does; :wq and :x typeset and close nothing', async ({ page, request }) => {
    const id = await createProject(request, 'Vim Write');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n' } });
      // Auto-typeset off: no typeset runs unless a command asks for one.
      await page.addInitScript(() => {
        localStorage.setItem('aldine.vim', '1');
        localStorage.setItem('aldine.autoTypeset', '0');
      });
      await openProject(page, id);
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');
      await page.locator('.cm-content').click();
      for (const command of [':w', ':wq', ':x']) {
        const compiled = page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST');
        await page.keyboard.type(command);
        await page.keyboard.press('Enter');
        expect((await compiled).ok()).toBe(true);
        await expectTypesetOk(page);
      }
      await expect(page.getByTestId('code-pane')).toBeVisible();
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.vim'); localStorage.removeItem('aldine.autoTypeset'); }).catch(() => {});
      await cleanup(request, id);
    }
  });

  test('Vim motions in Visual editing never change a byte of source', async ({ page, request }) => {
    const DOC = [
      '\\section{Introduction}',
      'Hello \\textbf{brave} new \\emph{world} of text.',
      '',
      '\\subsection{Details}',
      'More prose here with $x^2$ inline.',
      '',
    ].join('\n');
    const id = await createProject(request, 'Vim Visual');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await page.addInitScript(() => {
        localStorage.setItem('aldine.vim', '1');
        localStorage.setItem('aldine.editorMode', 'visual');
      });
      await openProject(page, id);
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');
      await line(page, 'More prose').click();
      await expect(page.locator('.cm-vis-b')).toContainText('brave');
      // A tour of motions across every construct: words, ends, lines, the
      // line's ends, paragraphs, the document's ends, back again.
      for (const keys of ['gg', 'w', 'w', 'w', 'e', 'e', 'b', 'j', 'l', 'l', 'l', 'h', '$', '0', 'j', 'j', 'w', 'w', 'w', 'w', '}', '{', 'G', 'k', 'k', 'gg']) {
        await page.keyboard.type(keys);
      }
      await page.keyboard.press('v');
      await page.keyboard.type('jj$');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--');
      // let the collab layer flush any (nonexistent) writes
      await page.waitForTimeout(3000);
      expect(await stored(request, id)).toBe(DOC);
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.vim'); localStorage.removeItem('aldine.editorMode'); }).catch(() => {});
      await cleanup(request, id);
    }
  });
});
