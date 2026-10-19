import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * The connector setup outside Account settings. This server runs with auth
 * off and ALDINE_MCP_TOKEN=aldine-e2e-mcp on localhost: Claude Code with the
 * header is the way in, claude.ai cannot reach it, and the token itself is
 * only ever named.
 */
test.describe('Connect Claude', () => {
  test('from project settings: the Claude Code command with the token header', async ({ page, request, baseURL }) => {
    const id = await createProject(request, 'Connect Claude');
    try {
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      await page.getByTestId('settings-connect-claude').click();
      const modal = page.getByTestId('connect-claude');
      await expect(modal).toBeVisible();
      await expect(page.getByTestId('project-settings')).toHaveCount(0);

      // localhost: nothing in Anthropic's cloud can reach it, so Claude Code
      // is the only route and there is nothing to switch between
      await expect(page.getByTestId('connect-client-cloud')).toHaveCount(0);
      await expect(page.getByTestId('agent-claude-code-command')).toHaveText(
        `claude mcp add --transport http aldine ${baseURL}/mcp --header "X-Aldine-Token: <ALDINE_MCP_TOKEN>"`,
      );
      await expect(page.getByTestId('agent-connector-unreachable')).toBeVisible();
      await expect(modal).not.toContainText('aldine-e2e-mcp');

      await page.getByTestId('connect-done').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('from the palette in the editor and the link on the project list', async ({ page, request }) => {
    const id = await createProject(request, 'Connect Claude 2');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('connect claude');
      await page.getByTestId('palette-item-connect-claude').click();
      await expect(page.getByTestId('connect-claude')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('connect-claude')).toHaveCount(0);

      await page.goto('/');
      await page.getByTestId('open-connect-claude').click();
      await expect(page.getByTestId('claude-connect')).toBeVisible();
      // no accounts on this server, so nothing to manage
      await expect(page.getByTestId('connect-manage')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a server with a public HTTPS address: claude.ai steps first, Claude Code one switch away', async ({ page, request }) => {
    // what /api/auth/me says when ALDINE_PUBLIC_URL is set
    await page.route('**/api/auth/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), publicUrl: 'https://papers.example.org' } });
    });
    const id = await createProject(request, 'Connect Claude 3');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('connect claude');
      await page.getByTestId('palette-item-connect-claude').click();
      await expect(page.getByTestId('connect-client-cloud')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('agent-connector-url')).toHaveText('https://papers.example.org/mcp');
      await expect(page.getByTestId('connect-static-header')).toContainText('X-Aldine-Token');
      await expect(page.getByTestId('agent-connector-unreachable')).toHaveCount(0);

      await page.getByTestId('connect-client-code').click();
      await expect(page.getByTestId('agent-claude-code-command')).toHaveText(
        'claude mcp add --transport http aldine https://papers.example.org/mcp --header "X-Aldine-Token: <ALDINE_MCP_TOKEN>"',
      );
    } finally {
      await cleanup(request, id);
    }
  });
});
