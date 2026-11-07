import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Claude editing a project people have open: it shows in every file of the
 * tree, its session survives a file switch (agent-1), its changes stay
 * marked in the gutter and the tree until reviewed (agent-6), a whole-file
 * write leaves a co-author's cursor where it was (agent-7), and an edit
 * under someone's cursor is refused (agent-8). The playwright config cuts
 * the agent presence TTL to 5 s.
 */

const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || `http://localhost:${process.env.E2E_PORT || 3100}`;

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Stable opening line.',
  '',
  'Results improve steadily across trials.',
  'Delete this sentence entirely.',
  'Closing remarks stay as they are.',
  '\\end{document}',
  '',
].join('\n');
const INTRO = 'The introduction opens here.\nIt says what the paper does.\n';

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

async function seed(request: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'intro.tex', content: INTRO } });
  return id;
}

test.describe('Claude editing an open project', () => {
  test('Claude in a file you do not have open shows in the tree, and switching files does not end its session', async ({ page, request }) => {
    test.setTimeout(120_000);
    const id = await seed(request, 'Agent Across Files');
    const client = await connect();
    try {
      await openProject(page, id);
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      const introRow = page.getByTestId('file-intro.tex');

      let n = 0;
      const touchIntro = async () => {
        n++;
        const r = await call(client, 'edit_file', { project: id, path: 'intro.tex', edits: [{ quote: 'It says what the paper does', replacement: `It says what the paper does (${n})` }] });
        expect(r.isError).toBeFalsy();
        expect(r.body.applied).toBe(1);
        // the next edit quotes the text as it is now
        await call(client, 'edit_file', { project: id, path: 'intro.tex', edits: [{ quote: `It says what the paper does (${n})`, replacement: 'It says what the paper does' }] });
      };
      await touchIntro();
      // Claude is in intro.tex, the person in main.tex: the tree says where it is
      await expect(introRow.getByTestId('tree-agent-live')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('file-main.tex').getByTestId('tree-agent-live')).toHaveCount(0);

      // The person follows it there and back while it keeps working. A
      // session that rode the open file's presence ended 4 s after each
      // switch away from Claude's file and raised the review prompt.
      await introRow.click();
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('file-main.tex').click();
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(1500);
        await touchIntro();
      }
      await expect(page.getByTestId('agent-session-review')).toHaveCount(0);

      // Claude stops: the session ends once, for the work in the file nobody had open
      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.toast', { hasText: 'Claude edited' })).toContainText('Claude edited 1 file');
      await expect(introRow.getByTestId('tree-agent-live')).toHaveCount(0);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test("Claude's changes stay marked in the gutter and the tree until reviewed, and a co-author's typing never is", async ({ browser, request }) => {
    test.setTimeout(120_000);
    const id = await seed(request, 'Agent Lasting Marks');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const client = await connect();
    try {
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await a.addInitScript(() => { localStorage.setItem('aldine.name', 'Ada'); localStorage.setItem('aldine.experimental.agentPresence', '1'); });
      await b.addInitScript(() => { localStorage.setItem('aldine.name', 'Bob'); });
      await openProject(a, id);
      await openProject(b, id);
      const marks = a.getByTestId('agent-gutter-mark');
      await expect(marks).toHaveCount(0);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [
          { quote: 'Stable opening line.', replacement: 'Stable opening line, now longer.' },
          { quote: 'Delete this sentence entirely.\n', replacement: '' },
        ],
        message: 'Lengthen the opening, drop a sentence',
      });
      expect(edit.isError).toBeFalsy();
      await expect(a.locator('.cm-content')).toContainText('Stable opening line, now longer.');
      // the tint shows only Claude's words, never the whole line
      await expect(a.locator('.cm-agent-edit').first()).toHaveText(', now longer', { timeout: 3000 });
      // one bar where it wrote, one notch where it removed a line
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="ins"]')).toHaveCount(1);
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="del"]')).toHaveCount(1);

      // Bob types on another line while Claude's session is live: not Claude's
      await b.locator('.cm-line', { hasText: 'Closing remarks stay' }).click();
      await b.keyboard.press('End');
      await b.keyboard.type(' BOB-TYPED');
      await expect(a.locator('.cm-content')).toContainText('BOB-TYPED');
      await a.waitForTimeout(500);
      await expect(a.locator('.cm-agent-edit', { hasText: 'BOB' })).toHaveCount(0);
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="ins"]')).toHaveCount(1);

      // Claude writes intro.tex, which nobody has open
      const intro = await call(client, 'edit_file', { project: id, path: 'intro.tex', edits: [{ quote: 'It says what the paper does.', replacement: 'It says what the paper does, and why.' }] });
      expect(intro.isError).toBeFalsy();
      // the tint has long faded; the marks have not, and survive a reload
      await a.waitForTimeout(4500);
      await expect(a.locator('.cm-agent-edit')).toHaveCount(0);
      await a.reload();
      await expect(a.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="ins"]')).toHaveCount(1);
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="del"]')).toHaveCount(1);
      await expect(a.getByTestId('file-main.tex').getByTestId(/tree-agent-/)).toBeVisible();
      await expect(a.getByTestId('file-intro.tex').getByTestId(/tree-agent-/)).toBeVisible();
      // the file nobody had open opens with its change marked
      await a.getByTestId('file-intro.tex').click();
      await expect(a.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      await expect(a.locator('.cm-content')).toContainText('and why.');
      await expect(a.locator('[data-testid="agent-gutter-mark"][data-kind="ins"]')).toHaveCount(1);

      // the session ends (during the reload or after it, so either prompt);
      // reviewing it is seeing the changes: the marks go
      const prompt = a.getByTestId(/^agent-(session|away)-review$/);
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      await expect(a.getByTestId('file-intro.tex').getByTestId('tree-agent-changed')).toBeVisible();
      await prompt.click();
      await expect(a.getByTestId('agent-review-modal')).toBeVisible();
      await a.getByRole('button', { name: 'Close' }).click();
      await expect(a.getByTestId('agent-gutter-mark')).toHaveCount(0);
      await expect(a.getByTestId('file-intro.tex').getByTestId(/tree-agent-/)).toHaveCount(0);
      await expect(a.getByTestId('file-main.tex').getByTestId(/tree-agent-/)).toHaveCount(0);
      // Bob has not reviewed anything: his marks stay
      await expect(b.locator('[data-testid="agent-gutter-mark"][data-kind="ins"]')).toHaveCount(1);
    } finally {
      await client.close().catch(() => {});
      await ctxA.close();
      await ctxB.close();
      await cleanup(request, id);
    }
  });

  test("a whole-file write leaves a co-author's cursor and typing where they were", async ({ page, request }) => {
    const id = await seed(request, 'Agent Whole File');
    const client = await connect();
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'Stable opening line.' }).click();
      await page.keyboard.press('End');
      const write = await call(client, 'write_file', {
        project: id, path: 'main.tex',
        content: MAIN.replace('Results improve steadily across trials.', 'Results improve markedly across trials.'),
      });
      expect(write.isError).toBeFalsy();
      await expect(page.locator('.cm-content')).toContainText('Results improve markedly');
      await page.keyboard.type(' KEPT-CURSOR');
      await expect(page.locator('.cm-content')).toContainText('Stable opening line. KEPT-CURSOR');
      await expect(page.locator('.cm-line').first()).toHaveText('\\documentclass{article}');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('an edit where someone is typing is refused with user_editing, and lands once they move on', async ({ page, request }) => {
    const id = await seed(request, 'Agent User Editing');
    const client = await connect();
    try {
      await page.addInitScript(() => { localStorage.setItem('aldine.name', 'Ada'); });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'Results improve steadily' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      // the caret reaches the server as awareness, a moment after the click
      await page.waitForTimeout(1000);
      const edit = { project: id, path: 'main.tex', edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }] };
      const refused = await call(client, 'edit_file', edit);
      expect(refused.body).toMatchObject({ error: 'user_editing', edit_index: 0, editors: ['Ada'], path: 'main.tex' });
      await page.waitForTimeout(500);
      await expect(page.locator('.cm-content')).toContainText('Results improve steadily across trials.');

      // the person moves to another line: the same edit lands
      await page.locator('.cm-line', { hasText: 'Closing remarks' }).click();
      await page.waitForTimeout(1000);
      const applied = await call(client, 'edit_file', edit);
      expect(applied.body.applied).toBe(1);
      await expect(page.locator('.cm-content')).toContainText('Results improve markedly across trials.');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });
});
