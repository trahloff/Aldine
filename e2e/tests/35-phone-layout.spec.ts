import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * The editor at phone width (≤640px), where the agent flow sends people: a
 * deep link to the line Claude edited, the review prompt and its dialog.
 * Geometry, not visibility — a 30px-wide editor still reports visible.
 */

const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || `http://localhost:${process.env.E2E_PORT || 3100}`;
const PHONE = { width: 390, height: 844 };

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

test.describe('phone layout', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('with the file tree hidden the editor fills the screen; History uses the width', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Editor');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      await page.getByRole('tab', { name: 'History' }).click();
      const sidebar = await page.locator('.sidebar').boundingBox();
      expect(sidebar!.width).toBeGreaterThanOrEqual(PHONE.width - 60);

      await page.getByTestId('sidebar-toggle').click(); // "Hide files"
      const content = await page.locator('.cm-content').boundingBox();
      expect(content!.width).toBeGreaterThanOrEqual(PHONE.width * 0.6);
      await expect(page.locator('.pane--preview')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // header controls sit beside or below each other, never on top of one another
      const jump = (await page.getByTestId('jump-to-pdf').boundingBox())!;
      const words = (await page.getByTestId('word-count').boundingBox())!;
      expect(words.x >= jump.x + jump.width - 1 || words.y >= jump.y + jump.height - 1).toBe(true);

      // a deep link to a line (the PDF viewer's and Claude's click-through) lands in the same state
      await page.goto(`/p/${id}?line=5`);
      await expect(page.locator('.cm-content')).toBeVisible();
      await expect(page.getByTestId('sidebar-toggle')).toHaveText('Files');
      const linked = await page.locator('.cm-content').boundingBox();
      expect(linked!.width).toBeGreaterThanOrEqual(PHONE.width * 0.6);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the review prompt keeps its buttons together and the dialog wraps long source lines', async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.addInitScript(() => window.localStorage.setItem('aldine.experimental.agentPresence', '1'));
    const id = await createProject(request, 'Phone Review');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await openProject(page, id);
      const long = 'Results improve steadily across trials, and this sentence keeps going well past the width of a phone screen so the diff must wrap it to stay readable.';
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: long }],
        message: 'Lengthen the results line',
      });
      expect(edit.isError).toBeFalsy();

      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      // Review and × are one group: the × never drops to a line of its own.
      // Centres, not tops — the × has the taller 40 px hit area on a touch screen.
      const review = (await page.getByTestId('agent-session-review').boundingBox())!;
      const dismiss = (await page.getByTestId('toast-dismiss').boundingBox())!;
      expect(Math.abs((review.y + review.height / 2) - (dismiss.y + dismiss.height / 2))).toBeLessThan(2);

      await page.getByTestId('agent-session-review').click();
      const modal = page.getByTestId('agent-review-modal');
      await expect(modal).toBeVisible();
      await expect(modal.locator('.review__commit').first()).toHaveText('Lengthen the results line');
      const diff = modal.getByTestId('diff-view').first();
      await expect(diff).toContainText('stay readable.');
      // wrapped, not clipped: nothing to scroll sideways, and the added line ends inside the dialog
      expect(await diff.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const added = (await diff.locator('.diff__add').first().boundingBox())!;
      const box = (await modal.boundingBox())!;
      expect(added.x + added.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(added.height).toBeGreaterThan(24); // more than one line tall
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('an error toast keeps its dot on the first line of the sentence', async ({ page, request }) => {
    const id = await createProject(request, 'Phone Toast');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      // a deep link to a file that is not here: a sentence long enough to wrap on a phone
      await page.goto(`/p/${id}?file=chapters/a-rather-long-chapter-name-for-a-phone-screen.tex`);
      const toast = page.locator('.toast', { hasText: 'is not in this project' });
      await expect(toast).toBeVisible();
      const dot = (await toast.locator('.dot--error').boundingBox())!;
      const text = (await toast.locator('.toast__text').boundingBox())!;
      expect(text.height).toBeGreaterThan(24); // it did wrap
      const dotMid = dot.y + dot.height / 2;
      expect(dotMid).toBeGreaterThan(text.y);
      expect(dotMid).toBeLessThan(text.y + 20);
    } finally {
      await cleanup(request, id);
    }
  });
});
