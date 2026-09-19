import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

/**
 * Agent presence + audit trust layer (UX.md), pinned end to end in a real
 * browser: server-side awareness relayed to clients (presence chip), the fade
 * highlight decoration, the violet history dot, and the session toast →
 * review modal → revert flow. All of it sits behind the
 * aldine.experimental.agentPresence flag, so nothing else in the suite
 * exercises these paths.
 */

const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || `http://localhost:${process.env.E2E_PORT || 3100}`;

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Stable opening line.',
  '',
  'Results improve steadily across trials.',
  '\\end{document}',
  '',
].join('\n');

async function connect(): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } } },
  ));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
}

test.describe('agent presence and audit UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.experimental.agentPresence', '1'));
  });

  test('agent edits show the presence chip, the fade highlight, and the history dot', async ({ page, request }) => {
    const id = await createProject(request, 'Agent Presence');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);

      // First agent edit: the server-side awareness state must relay to the
      // browser as the violet agent chip (glyph avatar, not an initial) — and
      // it must arrive BEFORE the edit, so the very first inserted range is
      // tinted too (decays ~4 s, so check at once).
      const edit1 = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Agent-adjusted opening line.' }],
      });
      expect(edit1.isError).toBeFalsy();
      expect(edit1.body.applied).toBe(1);
      await expect(page.locator('.cm-agent-edit').first()).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.cm-agent-edit').first()).toContainText('Agent-adjusted');
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.cm-content')).toContainText('Agent-adjusted opening line.');

      // Each edit is a commit authored Claude the moment it lands, with the
      // violet dot in history — and the panel, opened BEFORE the edit, shows
      // it without a tab switch (it polls while the agent is present).
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByTestId('history-panel')).toBeVisible();
      const edit2 = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
        message: 'Strengthen the results line',
      });
      expect(edit2.isError).toBeFalsy();
      expect(edit2.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect(page.locator('.cm-content')).toContainText('Results improve markedly across trials.');
      await expect(page.getByTestId('history-panel')).toContainText('Strengthen the results line', { timeout: 15_000 });
      await expect(page.getByTestId('agent-commit-dot').first()).toBeVisible();
      // nothing is left for a named checkpoint; the answer names the commits instead
      const committed = await call(client, 'commit', { project: id, message: 'Adjust opening and results lines' });
      expect(committed.isError).toBeFalsy();
      expect(committed.body.committed).toBe(false);
      expect(committed.body.recentClaudeCommits.map((c: any) => c.message)).toEqual(['Strengthen the results line', 'Edit main.tex']);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('an ended agent session raises the review toast; revert undoes its commits', async ({ page, request }) => {
    // Presence expiry drives the toast: ALDINE_AGENT_PRESENCE_TTL_MS is
    // shortened in playwright.config.ts; a compose stack keeps the 60 s
    // default, hence the generous timeouts.
    test.setTimeout(240_000);
    const id = await createProject(request, 'Agent Session Review');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve steadily across trials. AGENT-ADDED-SENTENCE.' }],
        message: 'Add a sentence to the results',
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });

      // Agent goes idle → presence expires → "Claude edited N files — Review".
      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      // By now auto-typeset has followed the agent's edit; note the run on screen.
      await expectTypesetOk(page);
      await expect(page.getByTestId('typeset-button')).toBeEnabled();
      const shownBefore = await page.getByTestId('download-pdf').getAttribute('href');
      await page.getByTestId('agent-session-review').click();
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await expect(page.getByTestId('agent-review-modal')).toContainText('AGENT-ADDED-SENTENCE');
      // each commit is a titled section in Claude's own words (no case
      // transform); the git header lines never show
      const heading = page.getByTestId('agent-review-commit').first().locator('.review__commit');
      await expect(heading).toHaveText('Add a sentence to the results');
      await expect(heading).toHaveCSS('text-transform', 'none');
      await expect(page.getByTestId('agent-review-modal')).not.toContainText('diff --git');

      // Revert creates a new commit undoing the session; the open editor
      // refreshes in place.
      await page.getByTestId('agent-revert').click();
      await expect(page.locator('.cm-content')).not.toContainText('AGENT-ADDED-SENTENCE', { timeout: 15_000 });
      await expect(page.locator('.cm-content')).toContainText('Results improve steadily across trials.');
      // Auto-typeset is on, so the preview stops showing what was just undone.
      await expect.poll(() => page.getByTestId('download-pdf').getAttribute('href'), { timeout: 60_000 }).not.toBe(shownBefore);
      await expectTypesetOk(page);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a project Claude changed while nobody watched prompts a review on the next open', async ({ page, request }) => {
    // Nothing is open while the agent works — the claude.ai case. Without
    // accounts the mark is the browser's, so this also pins agentSeen.ts.
    const id = await createProject(request, 'Agent Away Review');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'AWAY-EDITED-OPENING-LINE.' }],
        message: 'Rewrite the opening line',
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      // the session is still live (presence TTL): the prompt would wrongly
      // be left to a session toast this page never sees, so wait it out
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}/agent-activity?branch=main`)).json()).sessionActive, { timeout: 90_000 }).toBe(false);

      await openProject(page, id);
      await expect(page.getByTestId('agent-away-review')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.toast', { hasText: 'Claude edited' })).toContainText('Claude edited 1 file in this project');

      await page.getByTestId('agent-away-review').click();
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await expect(page.getByTestId('agent-review-commit').first()).toContainText('Rewrite the opening line');
      await expect(page.getByTestId('agent-review-modal')).toContainText('AWAY-EDITED-OPENING-LINE');
      await page.getByRole('button', { name: 'Close' }).click();

      // The visit was recorded: the next open asks the server the same
      // question and gets nothing back, so no toast is raised.
      const answer = page.waitForResponse((r) => r.url().includes('/agent-activity') && r.request().method() === 'GET');
      await page.reload();
      expect((await (await answer).json()).commitCount).toBe(0);
      await expect(page.locator('.cm-content')).toContainText('AWAY-EDITED-OPENING-LINE');
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('an ignored away prompt returns once, then counts as seen', async ({ page, request }) => {
    const id = await createProject(request, 'Agent Away Ignored');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'IGNORED-ONCE-OPENING-LINE.' }],
        message: 'Rewrite the opening line',
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}/agent-activity?branch=main`)).json()).sessionActive, { timeout: 90_000 }).toBe(false);

      // First open: nobody had ever seen this project, so the wording says so.
      await openProject(page, id);
      await expect(page.getByTestId('agent-away-review')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.toast', { hasText: 'Claude edited' })).toContainText('Claude edited 1 file in this project');

      // Second open without acting: the same batch is raised again.
      await page.reload();
      await expect(page.getByTestId('agent-away-review')).toBeVisible({ timeout: 15_000 });

      // Third open: the ignored prompt counts as seen.
      const answer = page.waitForResponse((r) => r.url().includes('/agent-activity') && r.request().method() === 'GET');
      await page.reload();
      expect((await (await answer).json()).commitCount).toBe(0);
      await expect(page.locator('.cm-content')).toContainText('IGNORED-ONCE-OPENING-LINE');
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a reload in the middle of a session keeps the chip, raises no away prompt, and the session toast still covers the whole session', async ({ page, request }) => {
    // The sole viewer's reload unloads the collab doc; the session must
    // survive that on the server. Timeouts allow for the compose default TTL.
    test.setTimeout(240_000);
    const id = await createProject(request, 'Agent Reload Mid-Session');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'RELOAD-SURVIVING-LINE.' }],
        message: 'Edit before the reload',
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });

      // The reload asks the server what Claude did; the answer must say a
      // session is live, and the page must trust that over its empty awareness.
      const answer = page.waitForResponse((r) => r.url().includes('/agent-activity') && r.request().method() === 'GET');
      await page.reload();
      const activity = await (await answer).json();
      expect(activity.commitCount).toBe(1);
      expect(activity.sessionActive).toBe(true);
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.cm-content')).toContainText('RELOAD-SURVIVING-LINE');
      await page.waitForTimeout(2500);
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);

      // The session ends: its toast reports the commit made before the reload.
      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);
      await page.getByTestId('agent-session-review').click();
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await expect(page.getByTestId('agent-review-commit').first()).toContainText('Edit before the reload');
      await expect(page.getByTestId('agent-review-modal')).toContainText('RELOAD-SURVIVING-LINE');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a revert that overlaps the person’s later edit names the commit and says what to do', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Agent Revert Conflict');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve steadily across trials. CONFLICTING-SENTENCE.' }],
        message: 'Add a sentence the person will touch',
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect(page.locator('.cm-content')).toContainText('CONFLICTING-SENTENCE');
      // The person edits the same line. The revert route checkpoints that as
      // their own commit first, so undoing Claude's commit no longer applies.
      await page.locator('.cm-line', { hasText: 'CONFLICTING-SENTENCE' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Then the person added this.');

      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      await page.getByTestId('agent-session-review').click();
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await page.getByTestId('agent-revert').click();
      const failed = page.locator('.toast', { hasText: 'Could not revert' });
      await expect(failed).toBeVisible();
      await expect(failed).toContainText(`Could not revert "Add a sentence the person will touch" (${edit.body.commit.slice(0, 7)})`);
      await expect(failed).toContainText('then revert again');
      await expect(failed).not.toContainText('Could not revert: Could not');
      // nothing was undone, and the dialog stays for another try
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await expect(page.locator('.cm-content')).toContainText('CONFLICTING-SENTENCE. Then the person added this.');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a session ending replaces the away prompt instead of stacking a second one', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Agent Toast Replace');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const first = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'AWAY-FIRST-LINE.' }],
        message: 'Rewrite the opening line',
      });
      expect(first.isError).toBeFalsy();
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}/agent-activity?branch=main`)).json()).sessionActive, { timeout: 90_000 }).toBe(false);
      await openProject(page, id);
      await expect(page.getByTestId('agent-away-review')).toBeVisible({ timeout: 15_000 });

      // Claude comes back while the away prompt is still on screen.
      const second = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
        message: 'Strengthen the results line',
      });
      expect(second.isError).toBeFalsy();
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      // one review prompt, not two with different commit sets behind them
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);
      await expect(page.locator('.toast', { hasText: 'Claude edited' })).toHaveCount(1);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a person who opened the project before Claude worked is told "while you were away"', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createProject(request, 'Agent Away Visited');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      // A quiet visit: nothing to review, and no prompt — but the visit is recorded.
      const answer = page.waitForResponse((r) => r.url().includes('/agent-activity') && r.request().method() === 'GET');
      await openProject(page, id);
      expect((await (await answer).json()).commitCount).toBe(0);
      await expect.poll(() => page.evaluate((k) => window.localStorage.getItem(k), `aldine.agentSeen.${id}.main`)).not.toBeNull();
      await expect(page.getByTestId('agent-away-review')).toHaveCount(0);
      await page.goto('/');

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'VISITED-AWAY-LINE.' }],
        message: 'Rewrite the opening line',
      });
      expect(edit.isError).toBeFalsy();
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}/agent-activity?branch=main`)).json()).sessionActive, { timeout: 90_000 }).toBe(false);

      await openProject(page, id);
      await expect(page.getByTestId('agent-away-review')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.toast', { hasText: 'Claude edited' })).toContainText('Claude edited 1 file while you were away');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('batch_write into an open document edits in place: cursor kept, only the inserted range tinted', async ({ page, request }) => {
    const id = await createProject(request, 'Agent Batch Live');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      // the person's cursor sits at the end of line 3
      await page.locator('.cm-line', { hasText: 'Stable opening line.' }).click();
      await page.keyboard.press('End');

      const batch = await call(client, 'batch_write', {
        project: id,
        files: [
          { path: 'discussion.tex', content: 'The discussion section, added by the agent.\n' },
          { path: 'main.tex', edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve steadily across trials. BATCHED-SENTENCE.' }] },
        ],
        message: 'Add a discussion and a sentence',
      });
      expect(batch.isError).toBeFalsy();
      expect(batch.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      await expect(page.locator('.cm-content')).toContainText('BATCHED-SENTENCE');
      // one tinted range, the inserted one — not the whole document
      await expect(page.locator('.cm-agent-edit').first()).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.cm-agent-edit').first()).toContainText('BATCHED-SENTENCE');
      expect(await page.locator('.cm-agent-edit').count()).toBeLessThanOrEqual(2);
      // the next keystrokes land where the cursor was, not at the top of the file
      await page.keyboard.type(' KEPT-CURSOR');
      await expect(page.locator('.cm-content')).toContainText('Stable opening line. KEPT-CURSOR');
      const onDisk = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(onDisk.startsWith('\\documentclass')).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });
});

/**
 * Auto-typeset follows the agent: an agent write signals the branch, every
 * open editor arms the same debounce a keystroke arms, and exactly one client
 * runs it. Not behind the agentPresence flag — this is the auto-typeset toggle
 * doing what it already promises, so no beforeEach here.
 */
test.describe('auto-typeset follows the agent', () => {
  /** The cache-buster on the preview's PDF link: it changes iff the preview
   *  moved to another run. */
  async function previewRun(page: import('@playwright/test').Page): Promise<string | null> {
    const href = await page.getByTestId('download-pdf').getAttribute('href');
    return href ? new URL(href, BASE).searchParams.get('t') : null;
  }

  /** Counts the typesets THIS browser asks for (the agent's own go over MCP). */
  function countClientCompiles(page: import('@playwright/test').Page): () => number {
    let n = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/compile$/.test(new URL(r.url()).pathname)) n++;
    });
    return () => n;
  }

  test('an agent edit typesets the preview with nobody typing', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Agent Auto Typeset');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      await expectTypesetOk(page);
      const before = await previewRun(page);
      expect(before).toBeTruthy();
      const compiles = countClientCompiles(page);

      // The only input is the agent's: no keyboard, no mouse, no compile tool.
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Line the agent typeset for us.' }],
      });
      expect(edit.isError).toBeFalsy();

      await expect.poll(() => previewRun(page), { timeout: 60_000 }).not.toBe(before);
      expect(compiles()).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('Claude’s own typeset is the one the preview shows', async ({ page, request }) => {
    test.setTimeout(180_000);
    const id = await createProject(request, 'Agent Typeset Adopted');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      await expectTypesetOk(page);
      const before = await previewRun(page);
      const compiles = countClientCompiles(page);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results the agent will typeset itself.' }],
      });
      expect(edit.isError).toBeFalsy();

      // The common case: Claude typesets a second after editing. The pending
      // client typeset is cancelled and the preview waits on the agent's run.
      const compiling = call(client, 'compile', { project: id });
      await expect(page.getByTestId('agent-typesetting')).toBeVisible({ timeout: 30_000 });
      const run = await compiling;
      expect(run.isError).toBeFalsy();
      const agentT = new URL(run.body.pdfUrl, BASE).searchParams.get('t');
      expect(agentT).toBeTruthy();
      expect(agentT).not.toBe(before);

      await expect.poll(() => previewRun(page), { timeout: 60_000 }).toBe(agentT);
      expect(compiles()).toBe(0);
      // Past the agent window: the cancelled timer never comes back.
      await page.waitForTimeout(8000);
      expect(compiles()).toBe(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('with auto-typeset off the preview stays where the person left it', async ({ page, request }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
    const id = await createProject(request, 'Agent Typeset Off');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      await expect(page.getByTestId('auto-toggle')).not.toHaveClass(/auto-toggle--on/);
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);
      const before = await previewRun(page);
      expect(before).toBeTruthy();
      const compiles = countClientCompiles(page);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Line nobody asked to see yet.' }],
      });
      expect(edit.isError).toBeFalsy();
      const run = await call(client, 'compile', { project: id });
      expect(run.isError).toBeFalsy();
      expect(new URL(run.body.pdfUrl, BASE).searchParams.get('t')).not.toBe(before);

      // Past both the agent window and the run: no status line, no rebuild,
      // and the preview still shows the person's own run.
      await page.waitForTimeout(8000);
      expect(await previewRun(page)).toBe(before);
      expect(compiles()).toBe(0);
      await expect(page.getByTestId('agent-typesetting')).toHaveCount(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });
});
