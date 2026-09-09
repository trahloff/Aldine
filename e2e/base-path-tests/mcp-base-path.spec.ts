import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';

/** Mirrors ALDINE_BASE_PATH in playwright.base-path.config.ts. */
const BASE = '/internal/aldine';
const ORIGIN = process.env.ALDINE_BASE_PATH_URL || `http://localhost:${process.env.E2E_BASE_PATH_PORT || 3300}`;
/** Must match ALDINE_MCP_TOKEN in playwright.base-path.config.ts (auth is off
 *  in this suite, so /mcp runs in static-token mode). */
const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';

async function connect(token = MCP_TOKEN): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${ORIGIN}${BASE}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  ));
  return client;
}

/** Tool results carry one JSON text block; guard failures are prose + isError. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
}

/** The shared helpers post to the unprefixed /api/projects, which is not ours here. */
async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${BASE}/api/projects`, { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}
async function cleanup(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`${BASE}/api/projects/${id}?permanent=1`).catch(() => {});
}

test.describe('MCP connector under a base path', () => {
  test('the connector answers under the prefix and nowhere else', async ({ request }) => {
    const noToken = await request.post(`${BASE}/mcp`, { data: { jsonrpc: '2.0', method: 'ping', id: 1 } });
    expect(noToken.status()).toBe(401);
    expect(noToken.headers()['content-type']).toContain('application/json');
    // auth off: there is no authorization server to point at
    expect(noToken.headers()['www-authenticate']).toBeUndefined();
    const atRoot = await request.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 1 }, headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    expect(atRoot.status()).toBe(404);
    expect(atRoot.headers()['content-type']).toContain('application/json');
    const get = await request.get(`${BASE}/mcp`, { headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    expect(get.status()).toBe(405);

    const id = await createProject(request, 'MCP under prefix');
    const client = await connect();
    try {
      await client.ping();
      const list = await call(client, 'list_projects', {});
      expect(list.isError).toBeFalsy();
      const mine = (list.body as Array<any>).find((p) => p.id === id);
      expect(mine).toBeTruthy();
      expect(mine.name).toBe('MCP under prefix');
      expect(mine.rootFile).toBe('main.tex');

      const struct = await call(client, 'project_structure', { project: id });
      expect(struct.isError).toBeFalsy();
      expect(struct.body.files.map((f: any) => f.path)).toContain('main.tex');

      // The viewer's CSP is the origin only — the prefix is a path, not an origin.
      const viewer = (await client.listResources()).resources.find((r) => r.uri === 'ui://aldine/pdf-viewer');
      expect(viewer).toBeTruthy();
      expect((viewer!._meta as any).ui.csp.connectDomains).toEqual([ORIGIN]);
    } finally {
      await client.close();
      await cleanup(request, id);
    }
  });

  test('signed PDF links and deep links carry the prefix', async ({ request }) => {
    const compiler = await (await request.get(`${BASE}/api/compiler`)).json();
    test.skip(!compiler.ok, 'needs a compiler sharing this suite\'s DATA_DIR (COMPILER_URL)');
    test.setTimeout(240_000); // a real latexmk run

    const id = await createProject(request, 'Typeset via MCP under prefix');
    // plain LaTeX only, so a BasicTeX box can typeset it too
    const put = await request.put(`${BASE}/api/projects/${id}/file`, {
      data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nUnder the prefix, via MCP.\n\\end{document}\n' },
    });
    expect(put.ok()).toBeTruthy();

    const client = await connect();
    try {
      const compiled = await call(client, 'compile', { project: id });
      expect(compiled.isError).toBeFalsy();
      expect(compiled.body.ok).toBe(true);
      expect(compiled.body.pdfUrl).toMatch(new RegExp(`^${ORIGIN}${BASE}/api/projects/${id}/output\\?`));
      expect(compiled.body.pdfUrl).toContain('sig=');
      expect(compiled.body.deepLink).toBe(`${ORIGIN}${BASE}/p/${id}`);

      // The request context carries no session: the signature alone authorises.
      const pdf = await request.get(compiled.body.pdfUrl);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('pdf');
      const unprefixed = await request.get(compiled.body.pdfUrl.replace(`${ORIGIN}${BASE}`, ORIGIN));
      expect(unprefixed.status()).toBe(404);

      const again = await call(client, 'get_pdf_url', { project: id });
      expect(again.isError).toBeFalsy();
      expect(again.body.pdfUrl).toMatch(new RegExp(`^${ORIGIN}${BASE}/api/projects/${id}/output\\?`));
      expect(again.body.pdfUrl).toContain('sig=');
      expect(again.body.deepLink).toBe(`${ORIGIN}${BASE}/p/${id}`);
      expect((await request.get(again.body.pdfUrl)).status()).toBe(200);
    } finally {
      await client.close();
      await cleanup(request, id);
    }
  });

  test('discovery is off under the prefix while auth is off — 404 JSON, never the app', async ({ request }) => {
    for (const url of [
      `${BASE}/.well-known/oauth-protected-resource`,
      `${BASE}/.well-known/oauth-protected-resource/mcp`,
      `${BASE}/.well-known/oauth-authorization-server`,
      `/.well-known/oauth-authorization-server${BASE}`,
      `/.well-known/oauth-protected-resource${BASE}`,
      `/.well-known/oauth-protected-resource${BASE}/mcp`,
      '/.well-known/oauth-authorization-server',
      `/.well-known/openid-configuration${BASE}`,
    ]) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(404);
      expect(res.headers()['content-type'], url).toContain('application/json');
    }
    const token = await request.post(`${BASE}/oauth/token`, { form: { grant_type: 'password' } });
    expect(token.status()).toBe(404);
    expect(token.headers()['content-type']).toContain('application/json');
  });
});
