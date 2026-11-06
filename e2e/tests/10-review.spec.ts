import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

test.describe('review mode', () => {
  test('select text, add a comment with a suggestion, accept it, and see the file change', async ({ page, request }) => {
    const id = await createProject(request, 'Review');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'PLACEHOLDER needs replacing.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('PLACEHOLDER', { timeout: 10_000 });

      // double-click precisely on PLACEHOLDER (start of the line)
      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
      await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('PLACEHOLDER');

      // add a comment + suggestion via the integrated composer (no browser dialog)
      await page.getByTestId('add-comment').click();
      await expect(page.getByTestId('comment-composer')).toBeVisible();
      await page.getByTestId('comment-body').fill('Rename this');
      await page.getByTestId('comment-suggest-toggle').click();
      await page.getByTestId('comment-suggestion').fill('REPLACED');
      await page.getByTestId('comment-submit').click();

      // it lands in the Review tab
      await expect(page.getByTestId('review-panel')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('review-panel')).toContainText('Rename this');
      await expect(page.getByTestId('review-panel')).toContainText('Suggested change');

      // accept the suggestion → file text updates
      await page.locator('[data-testid^="accept-"]').first().click();
      await expect(page.locator('.cm-content')).toContainText('REPLACED needs replacing', { timeout: 10_000 });
      await expect(page.locator('.cm-content')).not.toContainText('PLACEHOLDER');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a suggestion starts from the selected text, and emptied it suggests deleting it', async ({ page, request }) => {
    const id = await createProject(request, 'Review Delete');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'REDUNDANT words stay.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('REDUNDANT', { timeout: 10_000 });
      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
      await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('REDUNDANT');

      await page.getByTestId('add-comment').click();
      await page.getByTestId('comment-suggest-toggle').click();
      await expect(page.getByTestId('comment-suggestion')).toHaveValue('REDUNDANT');
      await expect(page.getByTestId('comment-submit'), 'an unchanged suggestion with no comment is nothing to send').toBeDisabled();
      await page.getByTestId('comment-suggestion').fill('');
      await expect(page.getByTestId('comment-submit')).toContainText('Suggest deleting');
      await page.getByTestId('comment-submit').click();

      await expect(page.getByTestId('review-panel')).toContainText('(delete)', { timeout: 10_000 });
      await page.locator('[data-testid^="accept-"]').first().click();
      await expect(page.locator('.cm-content')).toContainText(' words stay.');
      await expect(page.locator('.cm-content')).not.toContainText('REDUNDANT');
    } finally {
      await cleanup(request, id);
    }
  });

  test('comment can be resolved and reopened', async ({ page, request }) => {
    const id = await createProject(request, 'Review Resolve');
    try {
      const c = await (await request.post(`/api/projects/${id}/comments`, {
        data: { branch: 'main', file: 'main.tex', anchor: { from: 0, to: 5, quote: '\\docu' }, body: 'Check this' },
      })).json();
      await openProject(page, id);
      await page.getByTestId('tab-review').click();
      await expect(page.getByTestId(`comment-${c.id}`)).toContainText('Check this');
      await page.getByTestId(`resolve-${c.id}`).click();
      // resolved comments move under the "Resolved" divider
      await expect(page.getByTestId('review-panel')).toContainText('Resolved (1)', { timeout: 10_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('real-time review', () => {
  test('a comment added in one browser appears live in another', async ({ browser, request }) => {
    const id = await createProject(request, 'Live Review');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'Shared review document here.\n' } });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await a.goto(`/p/${id}`); await b.goto(`/p/${id}`);
      for (const p of [a, b]) {
        await expect(p.locator('.cm-content')).toContainText('Shared', { timeout: 10_000 });
      }
      await b.getByTestId('tab-review').click();
      await expect(b.getByTestId('review-panel')).toBeVisible();

      // A selects the word "Shared" and adds a comment through the composer
      const line = await a.locator('.cm-line').first().boundingBox();
      await a.mouse.dblclick(line!.x + 20, line!.y + line!.height / 2);
      await a.getByTestId('add-comment').click();
      await a.getByTestId('comment-body').fill('LIVE-COMMENT-XYZ');
      await a.getByTestId('comment-submit').click();
      await expect(a.getByTestId('review-panel')).toContainText('LIVE-COMMENT-XYZ', { timeout: 10_000 });

      // B, without reloading, receives the signal and re-fetches → sees the comment live
      await expect(b.getByTestId('review-panel')).toContainText('LIVE-COMMENT-XYZ', { timeout: 10_000 });
    } finally {
      await ctxA.close(); await ctxB.close();
      await cleanup(request, id);
    }
  });
});

test.describe('comment re-anchoring (QA regression)', () => {
  test('a comment highlight tracks its text after edits shift its offset', async ({ page, request }) => {
    const id = await createProject(request, 'Reanchor');
    try {
      // seed a file and anchor a comment on ANCHOR_ME at offset 0 via the API
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'ANCHOR_ME here.\nmore lines\n' } });
      const c = await request.post(`/api/projects/${id}/comments`, {
        data: { branch: 'main', file: 'main.tex', anchor: { from: 0, to: 9, quote: 'ANCHOR_ME' }, body: 'anchor test', author: 'QA' },
      });
      expect(c.ok()).toBeTruthy();
      // now shift ANCHOR_ME down by prepending text — the stored offset (0) is stale
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'PREPENDED LINE ONE\nPREPENDED LINE TWO\n' + 'ANCHOR_ME here.\nmore lines\n' } });
      // open fresh: the client must re-anchor the comment to ANCHOR_ME by its quote,
      // not leave the highlight on the (now different) text at offset 0
      await openProject(page, id);
      await expect(page.locator('.cm-comment-range')).toContainText('ANCHOR_ME', { timeout: 10_000 });
      await expect(page.locator('.cm-comment-range')).not.toContainText('PREPENDED');
    } finally {
      await cleanup(request, id);
    }
  });

  test('clicking a thread in Review opens its file and selects its text, after edits moved it', async ({ page, request }) => {
    const id = await createProject(request, 'Review Jump');
    try {
      const body = 'line one\nline two\nJUMP_HERE and more\n';
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'other.tex', content: body } });
      const from = body.indexOf('JUMP_HERE');
      const c = await (await request.post(`/api/projects/${id}/comments`, {
        data: { branch: 'main', file: 'other.tex', anchor: { from, to: from + 9, quote: 'JUMP_HERE' }, body: 'jump test' },
      })).json();
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'other.tex', content: `inserted above\n${body}` } });

      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await page.getByTestId('tab-review').click();
      await page.getByTestId(`comment-${c.id}`).locator('.review__anchor').click();
      await expect(page.getByTestId('active-file')).toHaveText('other.tex');
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('JUMP_HERE');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('comments that do not get lost', () => {
  test('a comment or reply the server refuses stays in its box for another try, and long comments save whole', async ({ page, request }) => {
    const id = await createProject(request, 'Review Keep');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'KEEPSAKE text to review.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('KEEPSAKE', { timeout: 10_000 });
      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('KEEPSAKE');

      // past 5,000 characters, and the first save fails
      const long = `LONG-START ${'careful review words '.repeat(400)}LONG-END`;
      let refuse = true;
      await page.route(`**/api/projects/${id}/comments`, (route) => (refuse && route.request().method() === 'POST'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The server is busy' }) })
        : route.fallback()));
      await page.getByTestId('add-comment').click();
      await page.getByTestId('comment-body').fill(long);
      await page.getByTestId('comment-submit').click();
      await expect(page.locator('.toast', { hasText: 'Could not save the comment: The server is busy' })).toBeVisible();
      await expect(page.getByTestId('comment-composer'), 'the composer stays open').toBeVisible();
      await expect(page.getByTestId('comment-body')).toHaveValue(long);
      refuse = false;
      await page.getByTestId('comment-submit').click();
      await expect(page.getByTestId('comment-composer')).toHaveCount(0);
      await expect(page.getByTestId('review-panel')).toContainText('LONG-END', { timeout: 10_000 });
      const saved = (await (await request.get(`/api/projects/${id}/comments?branch=main`)).json())[0];
      expect(saved.body).toBe(long);

      // a reply: Enter sends it, a refusal keeps it, Reply sends it again
      let refuseReply = true;
      await page.route(`**/api/projects/${id}/comments/${saved.id}/reply`, (route) => (refuseReply
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The server is busy' }) })
        : route.fallback()));
      const reply = page.getByTestId(`reply-${saved.id}`);
      await reply.fill('A REPLY WORTH KEEPING');
      await reply.press('Enter');
      await expect(page.locator('.toast', { hasText: 'Could not save the reply: The server is busy' })).toBeVisible();
      await expect(reply).toHaveValue('A REPLY WORTH KEEPING');
      refuseReply = false;
      await page.getByTestId(`reply-send-${saved.id}`).click();
      await expect(page.getByTestId(`comment-${saved.id}`).locator('.review__reply')).toContainText('A REPLY WORTH KEEPING');
      await expect(reply).toHaveValue('');

      // resolving that fails says so
      await page.route(`**/api/projects/${id}/comments/${saved.id}/resolve`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The server is busy' }) }));
      await page.getByTestId(`resolve-${saved.id}`).click();
      await expect(page.locator('.toast', { hasText: 'Could not resolve the comment: The server is busy' })).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('near the limit the composer counts, and past it waits instead of cutting the text', async ({ page, request }) => {
    const id = await createProject(request, 'Review Limit');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'LIMITED text.\n' } });
      await openProject(page, id);
      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 25, line!.y + line!.height / 2);
      await page.getByTestId('add-comment').click();
      await page.getByTestId('comment-body').fill('x'.repeat(19_000));
      await expect(page.getByTestId('comment-count')).toHaveText('19,000 of 20,000 characters');
      await expect(page.getByTestId('comment-submit')).toBeEnabled();
      await page.getByTestId('comment-body').fill('x'.repeat(20_001));
      await expect(page.getByTestId('comment-count')).toHaveText('20,001 of 20,000 characters: shorten it to post it');
      await expect(page.getByTestId('comment-submit')).toBeDisabled();
      await expect(page.getByTestId('comment-body')).toHaveValue('x'.repeat(20_001));
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('commented text', () => {
  test('shows its comment on hover and at the caret, opens it in Review, and Review follows the document', async ({ page, request }) => {
    const id = await createProject(request, 'Review Read');
    try {
      const main = '\\documentclass{article}\n\\begin{document}\nFIRST-SPOT starts here.\n\\input{intro}\nLATER-SPOT ends it.\n\\end{document}\n';
      const intro = 'INTRO-SPOT in the included file.\n';
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: main } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'intro.tex', content: intro } });
      const add = async (file: string, text: string, quote: string, body: string) => (await (await request.post(`/api/projects/${id}/comments`, {
        data: { branch: 'main', file, anchor: { from: text.indexOf(quote), to: text.indexOf(quote) + quote.length, quote }, body, author: 'Grace' },
      })).json()).id as string;
      // started in the opposite order to the text
      const intoIntro = await add('intro.tex', intro, 'INTRO-SPOT', 'Check the included file.');
      const later = await add('main.tex', main, 'LATER-SPOT', 'Tighten the ending.');
      const first = await add('main.tex', main, 'FIRST-SPOT', 'Say what starts here.');

      await openProject(page, id);
      await page.getByTestId('tab-review').click();
      const cards = page.locator('[data-testid="review-panel"] [data-comment-card]');
      await expect(cards).toHaveCount(3);
      await expect.poll(() => cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-comment-card')))).toEqual([first, later, intoIntro]);

      // hover: the comment, without moving the caret
      await page.getByTestId('tab-files').click();
      await page.locator(`.cm-comment-range[data-comment-id="${later}"]`).hover();
      await expect(page.getByTestId('comment-hover')).toContainText('Tighten the ending.');
      await expect(page.getByTestId('comment-hover')).toContainText('Grace');
      await page.mouse.move(5, 5);
      await expect(page.getByTestId('comment-hover'), 'it goes with the pointer').toHaveCount(0);

      // a click puts the caret in it: the card stays while it is there
      await page.locator(`.cm-comment-range[data-comment-id="${first}"]`).click();
      await expect(page.getByTestId('comment-tip')).toContainText('Say what starts here.');
      await page.getByTestId('comment-tip').getByTestId('comment-tip-open').click();
      await expect(page.getByTestId('review-panel')).toBeVisible();
      await expect(page.getByTestId(`comment-${first}`)).toHaveClass(/review__item--active/);

      // typing in the text puts the card away; the text is the typed text, nothing more
      await page.keyboard.type('Z');
      await expect(page.getByTestId('comment-tip')).toHaveCount(0);
      await expect(page.locator('.cm-line', { hasText: 'starts here' })).toContainText('Z');
      // Escape puts it away too
      await page.locator(`.cm-comment-range[data-comment-id="${later}"]`).click();
      await expect(page.getByTestId('comment-tip')).toContainText('Tighten the ending.');
      await expect(page.getByTestId(`comment-${later}`)).toHaveClass(/review__item--active/);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('comment-tip')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
