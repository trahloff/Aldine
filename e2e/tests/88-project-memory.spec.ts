import { test, expect } from '../fixtures';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Project memory (docs/PROJECT_MEMORY.md): a project started from "Article
 * with project memory" in the chooser has the four memory files next to the
 * paper, and an assistant connected to the instance is told to read them and
 * finds them through project_structure.
 */
const MEMORY = ['FINDINGS.md', 'DECISIONS.md', 'TASKS.md', 'RESULTS.md'];

test.describe('project memory', () => {
  test('the chooser starts a project with the four memory files, and a connected assistant is told about them and finds them', async ({ page, baseURL }) => {
    await page.goto('/');
    const add = page.getByTestId('home-add');
    await expect(add.or(page.getByTestId('new-project'))).toBeVisible();
    if (await add.isVisible()) {
      await add.click();
      await page.getByTestId('home-add-sheet').getByTestId('new-project').click();
    } else {
      await page.getByTestId('new-project').click();
    }
    const tile = page.getByTestId('template-article-memory');
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Article with project memory');
    await tile.click();
    await page.getByLabel('Project name').fill('Memory e2e');
    await page.getByTestId('create-project').click();
    await page.waitForURL(/\/p\/[a-z0-9]+/);
    const id = new URL(page.url()).pathname.split('/')[2];
    await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
    for (const f of MEMORY) await expect(page.getByTestId(`file-${f}`)).toBeVisible();
    await page.getByTestId('file-TASKS.md').click();
    await expect(page.locator('.cm-content')).toContainText('Open work, one line each, with an owner.');

    const client = new Client({ name: 'aldine-e2e-memory', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp'}` } },
    }));
    try {
      expect(client.getInstructions()).toContain('project memory');
      const res = await client.callTool({ name: 'project_structure', arguments: { project: id } });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(body.memory.map((m: { path: string }) => m.path)).toEqual(MEMORY);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
