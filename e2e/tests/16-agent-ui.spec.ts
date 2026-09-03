import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

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
      // browser as the violet agent chip (glyph avatar, not an initial).
      const edit1 = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Agent-adjusted opening line.' }],
      });
      expect(edit1.isError).toBeFalsy();
      expect(edit1.body.applied).toBe(1);
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.cm-content')).toContainText('Agent-adjusted opening line.');

      // Second edit lands while the agent is present in awareness → the
      // inserted range carries the fade decoration (decays ~4 s, so check now).
      const edit2 = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
      });
      expect(edit2.isError).toBeFalsy();
      await expect(page.locator('.cm-agent-edit').first()).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.cm-content')).toContainText('Results improve markedly across trials.');

      // Commits authored Claude get the violet dot in history.
      const committed = await call(client, 'commit', { project: id, message: 'Adjust opening and results lines' });
      expect(committed.isError).toBeFalsy();
      expect(committed.body.committed).toBe(true);
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByTestId('history-panel')).toContainText('Adjust opening and results lines', { timeout: 10_000 });
      await expect(page.getByTestId('agent-commit-dot').first()).toBeVisible();
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
      });
      expect(edit.isError).toBeFalsy();
      await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
      const committed = await call(client, 'commit', { project: id, message: 'Add a sentence to the results' });
      expect(committed.body.committed).toBe(true);

      // Agent goes idle → presence expires → "Claude edited N files — Review".
      await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 90_000 });
      await page.getByTestId('agent-session-review').click();
      await expect(page.getByTestId('agent-review-modal')).toBeVisible();
      await expect(page.getByTestId('agent-review-modal')).toContainText('AGENT-ADDED-SENTENCE');

      // Revert creates a new commit undoing the session; the open editor
      // refreshes in place.
      await page.getByTestId('agent-revert').click();
      await expect(page.locator('.cm-content')).not.toContainText('AGENT-ADDED-SENTENCE', { timeout: 15_000 });
      await expect(page.locator('.cm-content')).toContainText('Results improve steadily across trials.');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });
});
