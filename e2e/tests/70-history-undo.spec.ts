import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup, typeAtEnd } from './helpers';

/**
 * The way back, and a History that reads: autosaves fold, named checkpoints
 * stand out, a diff marks the words that changed, any change can be undone
 * from its diff, a deleted file or folder comes back from its toast, Claude's
 * work can be reviewed after its prompt is gone, a conflicted merge offers to
 * bring main into the branch, manual commits ask for a message before a
 * branch takes the waiting edits along, and Search deletes only on purpose.
 */

const put = (request: APIRequestContext, id: string, branch: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch, path, content } });

const commit = async (request: APIRequestContext, id: string, message: string, author?: string, branch = 'main') => {
  const res = await request.post(`/api/projects/${id}/commit`, { data: { branch, message, ...(author ? { author } : {}) } });
  expect((await res.json()).committed).toBe(true);
};

const fileText = async (request: APIRequestContext, id: string, path: string, branch = 'main') =>
  (await request.get(`/api/projects/${id}/file?branch=${branch}&path=${encodeURIComponent(path)}`)).text();

const log = async (request: APIRequestContext, id: string, branch = 'main') =>
  (await (await request.get(`/api/projects/${id}/log?branch=${branch}`)).json()) as Array<{ hash: string; message: string; author: string }>;

const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test.describe('History', () => {
  test('folds autosaves, marks named checkpoints, marks the changed word, and takes a change back', async ({ page, request }) => {
    const id = await createProject(request, 'History Reads');
    try {
      const para = 'The results improve steadily across all trials, and overall the effect is small but consistent across every setting we tried.';
      expect((await put(request, id, 'main', 'main.tex', doc(para))).ok()).toBeTruthy();
      await commit(request, id, 'Draft the results', 'Ada');
      for (const f of ['a', 'b', 'c']) {
        expect((await put(request, id, 'main', `notes/${f}.tex`, `${f}\n`)).ok()).toBeTruthy();
        await commit(request, id, 'aldine: autosave');
      }
      expect((await put(request, id, 'main', 'main.tex', doc(para.replace('small', 'large')))).ok()).toBeTruthy();
      await commit(request, id, 'Say the effect is large', 'Ada');
      await openProject(page, id);

      // a tab of its own, not a menu item
      await page.getByTestId('tab-history').click();
      const panel = page.getByTestId('history-panel');
      const folded = panel.getByTestId('history-autosaves');
      await expect(folded).toHaveCount(1);
      await expect(folded).toContainText('3 autosaves');
      await expect(folded.getByTestId('history-files')).toHaveText('notes/c.tex, notes/b.tex and 1 more');
      await folded.getByTestId('history-autosaves-toggle').click();
      await expect(folded.locator('[data-kind="autosave"]')).toHaveCount(3);
      await expect(folded.locator('[data-kind="autosave"]').first()).toContainText('Autosave');
      await expect(panel).not.toContainText('aldine: autosave');
      // the named checkpoint stands out, with its author and the file it changed
      const named = panel.locator('[data-kind="checkpoint"]').filter({ hasText: 'Draft the results' });
      await expect(named.getByTestId('checkpoint-mark')).toBeVisible();
      await expect(named).toContainText('Ada');
      await expect(named.getByTestId('history-files')).toHaveText('main.tex');
      await expect(folded.getByTestId('checkpoint-mark')).toHaveCount(0);

      // a one-word edit marks the word, not the paragraph
      await panel.getByText('Say the effect is large').click();
      const dialog = page.getByTestId('diff-dialog');
      await expect(dialog.locator('.diff__del [data-testid="diff-word"]')).toHaveText(['small']);
      await expect(dialog.locator('.diff__add [data-testid="diff-word"]')).toHaveText(['large']);
      expect(await dialog.getByTestId('diff-view').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

      await dialog.getByTestId('diff-undo').click();
      await expect(toast(page, 'Undid “Say the effect is large”')).toBeVisible();
      await expect(page.getByTestId('diff-dialog')).toHaveCount(0);
      await expect.poll(() => fileText(request, id, 'main.tex')).toContain('effect is small');
      await expect(page.locator('.cm-content')).toContainText('effect is small');
      await expect(panel).toContainText('Undo “Say the effect is large”');
      expect((await log(request, id))[0].message).toBe('Undo “Say the effect is large”');

      await page.getByTestId('history-redo').click();
      await expect(toast(page, 'Redid “Say the effect is large”')).toBeVisible();
      await expect.poll(() => fileText(request, id, 'main.tex')).toContain('effect is large');

      // the first commit has nothing before it to go back to
      await panel.getByText('Initial commit').click();
      await expect(page.getByTestId('diff-dialog')).toBeVisible();
      await expect(page.getByTestId('diff-undo')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('pages back with Show older', async ({ page, request }) => {
    // 52 commits through the API: slow on a busy machine
    test.setTimeout(240_000);
    const id = await createProject(request, 'History Pages');
    try {
      for (let i = 1; i <= 52; i++) {
        expect((await put(request, id, 'main', 'note.tex', `note ${i}\n`)).ok()).toBeTruthy();
        await commit(request, id, `Note ${i}`, 'Ada');
      }
      await openProject(page, id);
      await page.getByTestId('tab-history').click();
      const panel = page.getByTestId('history-panel');
      // a named checkpoint's title reads "Checkpoint: …" to a screen reader
      const titled = (t: string) => panel.locator('.history__msg').filter({ hasText: new RegExp(`^Checkpoint: ${t}$`) });
      await expect(titled('Note 52')).toBeVisible();
      await expect(panel.getByText('Initial commit')).toHaveCount(0);
      await page.getByTestId('history-older').click();
      await expect(panel.getByText('Initial commit')).toBeVisible();
      await expect(titled('Note 1')).toBeVisible();
      await expect(page.getByTestId('history-older')).toHaveCount(0);
      // a later reload keeps what is on screen
      await page.getByTestId('tab-files').click();
      await page.getByTestId('tab-history').click();
      await expect(panel.getByText('Initial commit')).toBeVisible();
      await expect(page.getByTestId('history-older')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a deleted file or folder comes back from the toast', async ({ page, request }) => {
    const id = await createProject(request, 'Delete Undo');
    try {
      expect((await put(request, id, 'main', 'notes.tex', 'Notes, typed a moment ago.\n')).ok()).toBeTruthy();
      expect((await put(request, id, 'main', 'chapters/one.tex', 'Chapter one.\n')).ok()).toBeTruthy();
      expect((await put(request, id, 'main', 'chapters/two.tex', 'Chapter two.\n')).ok()).toBeTruthy();
      await openProject(page, id);

      await page.getByTestId('file-notes.tex').click({ button: 'right' });
      await page.getByTestId('file-menu-delete').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('file-notes.tex')).toHaveCount(0);
      await expect(toast(page, 'Deleted notes.tex')).toBeVisible();
      await page.getByTestId('delete-undo').click();
      await expect(toast(page, 'Restored notes.tex')).toBeVisible();
      await expect(page.getByTestId('file-notes.tex')).toBeVisible();
      expect(await fileText(request, id, 'notes.tex')).toBe('Notes, typed a moment ago.\n');

      await page.getByTestId('dir-chapters').click({ button: 'right' });
      await page.getByTestId('folder-menu-delete').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dir-chapters')).toHaveCount(0);
      await page.getByTestId('delete-undo').click();
      await expect(toast(page, 'Restored chapters')).toBeVisible();
      await expect(page.getByTestId('dir-chapters')).toBeVisible();
      expect(await fileText(request, id, 'chapters/two.tex')).toBe('Chapter two.\n');
      const messages = (await log(request, id)).map((c) => c.message);
      expect(messages.slice(0, 2)).toEqual(['Undo the deletion of chapters', 'Delete folder chapters']);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Claude’s edits can be reviewed and undone after the prompt is gone', async ({ page, request }) => {
    const id = await createProject(request, 'Claude Later');
    try {
      expect((await put(request, id, 'main', 'main.tex', doc('Stable opening line.'))).ok()).toBeTruthy();
      await commit(request, id, 'Seed the paper', 'Ada');
      expect((await put(request, id, 'main', 'main.tex', doc('Stable opening line.\n\nCLAUDE-SENTENCE here.'))).ok()).toBeTruthy();
      await commit(request, id, 'Add a closing sentence', 'Claude');

      await openProject(page, id);
      const away = page.locator('.toast').filter({ has: page.getByTestId('agent-away-review') });
      await expect(away).toBeVisible({ timeout: 15_000 });
      await away.getByTestId('toast-dismiss').click();
      await page.reload();
      await expect(page.locator('.cm-content')).toContainText('CLAUDE-SENTENCE');
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);

      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('review claude');
      await expect(page.getByTestId('palette-item-review-claude')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('agent-review-modal')).toContainText('Add a closing sentence');
      await expect(page.getByTestId('agent-review-modal')).toContainText('CLAUDE-SENTENCE');
      await page.keyboard.press('Escape');

      // the same commit undone from History, as any other change
      await page.getByTestId('tab-history').click();
      const row = page.getByTestId('history-panel').locator('[data-kind="agent"]').filter({ hasText: 'Add a closing sentence' });
      await expect(row.getByTestId('agent-commit-dot')).toBeVisible();
      await row.click();
      await page.getByTestId('diff-undo').click();
      await expect(toast(page, 'Undid “Add a closing sentence”')).toBeVisible();
      await expect(page.locator('.cm-content')).not.toContainText('CLAUDE-SENTENCE');
      await expect(page.locator('.cm-content')).toContainText('Stable opening line.');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('branches', () => {
  test('a conflicted merge offers to bring main into the branch, and other failures say why', async ({ page, request }) => {
    const id = await createProject(request, 'Merge Conflict');
    try {
      expect((await put(request, id, 'main', 'main.tex', doc('Line: original.'))).ok()).toBeTruthy();
      await commit(request, id, 'Seed', 'Ada');
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft', from: 'main' } })).ok()).toBeTruthy();
      expect((await put(request, id, 'draft', 'main.tex', doc('Line: from the draft.'))).ok()).toBeTruthy();
      await commit(request, id, 'Draft line', 'Ada', 'draft');
      expect((await put(request, id, 'main', 'main.tex', doc('Line: from main.'))).ok()).toBeTruthy();
      await commit(request, id, 'Main line', 'Ada');
      await openProject(page, id);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await page.getByTestId('dialog-confirm').click();
      const dialog = page.getByTestId('merge-conflict-dialog');
      await expect(dialog).toContainText('draft and main changed the same lines');
      await expect(dialog.getByTestId('merge-conflict-files')).toHaveText('main.tex');
      expect(await fileText(request, id, 'main.tex')).toBe(doc('Line: from main.'));

      await dialog.getByTestId('merge-conflict-bring-main').click();
      await expect(toast(page, 'Brought main into draft: 1 file holds both versions')).toBeVisible();
      await expect(page.getByTestId('branch-menu')).toContainText('draft');
      await expect(page.locator('.cm-content')).toContainText('<<<<<<<', { timeout: 15_000 });
      await expect(page.locator('.cm-content')).toContainText('Line: from the draft.');
      await expect(page.locator('.cm-content')).toContainText('Line: from main.');
      expect(await fileText(request, id, 'main.tex')).toBe(doc('Line: from main.'));

      await page.route(`**/api/projects/${id}/merge`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'the disk is full' }) }));
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('merge-draft').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Could not merge draft into main: the disk is full')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('with manual commits, a new branch asks for a message for the waiting edits', async ({ page, request }) => {
    const id = await createProject(request, 'Manual Branch');
    try {
      expect((await request.patch(`/api/projects/${id}`, { data: { manualCommits: true } })).ok()).toBeTruthy();
      expect((await put(request, id, 'main', 'main.tex', doc('Waiting opening.'))).ok()).toBeTruthy();
      const before = (await log(request, id)).length;
      await openProject(page, id);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('new-branch').click();
      await page.getByTestId('new-branch-name').fill('side');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('dialog-title')).toHaveText('Commit 1 waiting file before branching');
      await expect(page.getByTestId('dialog-message')).toContainText('main.tex is not committed yet');
      await expect(page.getByTestId('dialog-confirm')).toBeDisabled();
      await page.getByTestId('dialog-input').fill('Rewrite the opening');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('branch-menu')).toContainText('side', { timeout: 15_000 });
      const entries = await log(request, id);
      expect(entries.length).toBe(before + 1);
      expect(entries[0].message).toBe('Rewrite the opening');
      expect(entries[0].author).not.toBe('Aldine');

      // an undo with edits waiting asks too, and Cancel leaves everything alone
      await typeAtEnd(page, ' TYPED-ON-SIDE');
      await page.getByTestId('tab-history').click();
      await expect(page.getByTestId('uncommitted-changes')).toContainText('1 file not committed yet', { timeout: 15_000 });
      await page.getByTestId('history-panel').getByText('Rewrite the opening').click();
      await page.getByTestId('diff-undo').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Commit 1 waiting file before undoing this change');
      await page.getByTestId('dialog-cancel').click();
      expect((await log(request, id, 'side')).length).toBe(before + 1);
      await expect(page.getByTestId('diff-dialog')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('project search', () => {
  test('rows replace only once a replacement is typed; Delete matches is its own action with Undo', async ({ page, request }) => {
    const id = await createProject(request, 'Delete Matches');
    try {
      expect((await put(request, id, 'main', 'chapters/a.tex', 'colour and colour\n')).ok()).toBeTruthy();
      await openProject(page, id);
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('colour');
      await expect(page.locator('[data-testid="search-file"][data-path="chapters/a.tex"]').getByTestId('search-file-count')).toHaveText('2');
      await expect(page.getByTestId('search-replace-one')).toHaveCount(0);
      await expect(page.getByTestId('search-replace-all')).toHaveAttribute('aria-disabled', 'true');
      // Enter in the empty field asks for a replacement instead of deleting
      await page.getByTestId('search-replace-input').press('Enter');
      await expect(toast(page, 'Type what to replace the matches with, or use Delete matches')).toBeVisible();
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);
      expect(await fileText(request, id, 'chapters/a.tex')).toBe('colour and colour\n');

      await page.getByTestId('search-delete-all').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Delete 2 matches in 1 file?');
      await page.getByTestId('dialog-confirm').click();
      await expect(toast(page, 'Deleted 2 matches in chapters/a.tex')).toBeVisible();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe(' and \n');
      await page.getByTestId('replace-undo').click();
      await expect(toast(page, 'Undid the delete of 2 matches')).toBeVisible();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe('colour and colour\n');

      await page.getByTestId('search-replace-input').fill('color');
      await expect(page.getByTestId('search-replace-one')).toHaveCount(2);
      await expect(page.getByTestId('search-replace-one').first()).toHaveAttribute('aria-label', 'Replace this match');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('manual commits', () => {
  test('Replace all and a delete can be undone without a commit, and a file changed since is left alone', async ({ page, request }) => {
    const id = await createProject(request, 'Manual Undo');
    try {
      expect((await request.patch(`/api/projects/${id}`, { data: { manualCommits: true } })).ok()).toBeTruthy();
      expect((await put(request, id, 'main', 'chapters/a.tex', 'colour in a\n')).ok()).toBeTruthy();
      expect((await put(request, id, 'main', 'chapters/b.tex', 'colour in b\n')).ok()).toBeTruthy();
      const before = (await log(request, id)).length;
      await openProject(page, id);

      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('colour');
      await expect(page.getByTestId('search-summary')).toHaveText('2 results in 2 files');
      await page.getByTestId('search-replace-input').fill('color');
      await page.getByTestId('search-replace-all').click();
      await page.getByTestId('dialog-confirm').click();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe('color in a\n');
      await page.getByTestId('replace-undo').click();
      await expect(toast(page, 'Undid the replace of 2 matches')).toBeVisible();
      await expect.poll(() => fileText(request, id, 'chapters/a.tex')).toBe('colour in a\n');
      expect(await fileText(request, id, 'chapters/b.tex')).toBe('colour in b\n');

      // again, with b.tex edited after the replace: the undo leaves it be
      await page.getByTestId('search-input').fill('colour');
      await expect(page.getByTestId('search-summary')).toHaveText('2 results in 2 files');
      await page.getByTestId('search-replace-all').click();
      await page.getByTestId('dialog-confirm').click();
      await expect.poll(() => fileText(request, id, 'chapters/b.tex')).toBe('color in b\n');
      expect((await put(request, id, 'main', 'chapters/b.tex', 'color in b, edited\n')).ok()).toBeTruthy();
      await page.getByTestId('replace-undo').click();
      await expect(toast(page, 'Undid the replace of 2 matches; left chapters/b.tex alone: changed since')).toBeVisible();
      expect(await fileText(request, id, 'chapters/a.tex')).toBe('colour in a\n');
      expect(await fileText(request, id, 'chapters/b.tex')).toBe('color in b, edited\n');

      // a folder delete comes back too
      await page.getByTestId('tab-files').click();
      await page.getByTestId('dir-chapters').click({ button: 'right' });
      await page.getByTestId('folder-menu-delete').click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('dir-chapters')).toHaveCount(0);
      await expect(toast(page, 'Deleted chapters — commit it from History')).toBeVisible();
      await page.getByTestId('delete-undo').click();
      await expect(toast(page, 'Restored chapters')).toBeVisible();
      await expect(page.getByTestId('dir-chapters')).toBeVisible();
      expect(await fileText(request, id, 'chapters/a.tex')).toBe('colour in a\n');
      expect((await log(request, id)).length).toBe(before);
    } finally {
      await cleanup(request, id);
    }
  });
});
