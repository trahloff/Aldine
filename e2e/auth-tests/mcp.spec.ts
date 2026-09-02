import { request as pwRequest } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';

/** Unique email per run so re-runs don't collide with the persisted user store. */
const uniq = () => `mcp${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;

async function connect(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e-auth', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${base}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  ));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
}

test.describe('MCP over PAT auth', () => {
  test('scoped PAT: in-scope tools work, out-of-scope is a tool-level refusal, bad credentials get 401', async ({ request, baseURL }) => {
    // register over the API — the request fixture keeps the session cookie
    const reg = await request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'MCP Tester' } });
    expect(reg.ok()).toBeTruthy();
    const inScope = await (await request.post('/api/projects', { data: { name: 'MCP In Scope' } })).json();
    const outScope = await (await request.post('/api/projects', { data: { name: 'MCP Out Of Scope' } })).json();
    await request.put(`/api/projects/${inScope.id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'SCOPED-CONTENT\n' } });

    const minted = await (await request.post('/api/tokens', { data: { name: 'MCP e2e', projectIds: [inScope.id] } })).json();
    expect(minted.token).toMatch(/^aldn_/);

    const client = await connect(baseURL!, minted.token);
    try {
      // scope shapes the listing: the other project does not exist for this token
      const list = await call(client, 'list_projects', {});
      expect(list.isError).toBeFalsy();
      const ids = (list.body as Array<any>).map((p) => p.id);
      expect(ids).toContain(inScope.id);
      expect(ids).not.toContain(outScope.id);

      // single-project scope makes `project` optional — the token is the context
      const read = await call(client, 'read_file', { path: 'main.tex' });
      expect(read.isError).toBeFalsy();
      expect(read.body.content).toBe('SCOPED-CONTENT\n');

      // crossing the scope surfaces as a tool-level refusal, not a crash
      const denied = await call(client, 'read_file', { project: outScope.id, path: 'main.tex' });
      expect(denied.isError).toBeTruthy();
      expect(denied.text).toMatch(/does not have access/i);
      const deniedStruct = await call(client, 'project_structure', { project: outScope.id });
      expect(deniedStruct.isError).toBeTruthy();
      // the session stays healthy after the refusal
      const ping = await call(client, 'ping', {});
      expect(ping.body.ok).toBe(true);
    } finally {
      await client.close().catch(() => {});
    }

    // credential negatives from a cookie-less context: /mcp never falls back to
    // the browser session — only a live PAT counts
    const anon = await pwRequest.newContext({ baseURL });
    try {
      const rpc = { jsonrpc: '2.0', method: 'ping', id: 1 };
      expect((await anon.post('/mcp', { data: rpc })).status()).toBe(401);
      expect((await anon.post('/mcp', { data: rpc, headers: { authorization: 'Bearer aldn_wrongwrongwrongwrong' } })).status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    // a session cookie alone (no bearer) does not open /mcp either
    expect((await request.post('/mcp', { data: { jsonrpc: '2.0', method: 'ping', id: 2 } })).status()).toBe(401);
  });

  test('create_project: a project-scoped PAT is refused at tool level, an unscoped PAT creates a project the user owns', async ({ request, baseURL }) => {
    const reg = await request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name: 'MCP Creator' } });
    expect(reg.ok()).toBeTruthy();
    const anchor = await (await request.post('/api/projects', { data: { name: 'MCP Scope Anchor' } })).json();
    const myProjects = async () => (await (await request.get('/api/projects')).json()) as Array<{ id: string; name: string }>;

    // ---- scoped: the token's blast radius stays the one project ----
    const scoped = await (await request.post('/api/tokens', { data: { name: 'Scoped', projectIds: [anchor.id] } })).json();
    const scopedClient = await connect(baseURL!, scoped.token);
    try {
      const denied = await call(scopedClient, 'create_project', { name: 'Escape attempt' });
      expect(denied.isError).toBeTruthy();
      expect(denied.text).toMatch(/scoped/i);
      expect(denied.text).toMatch(/cannot create/i);
      // nothing was created — not for the token, not for the user
      const list = await call(scopedClient, 'list_projects', {});
      expect((list.body as Array<any>).map((p) => p.name)).not.toContain('Escape attempt');
      expect((await myProjects()).map((p) => p.name)).not.toContain('Escape attempt');
      // the session stays healthy after the refusal
      const ping = await call(scopedClient, 'ping', {});
      expect(ping.body.ok).toBe(true);
    } finally {
      await scopedClient.close().catch(() => {});
    }

    // ---- unscoped: creates, and the project belongs to the token's user ----
    const unscoped = await (await request.post('/api/tokens', { data: { name: 'Unscoped' } })).json();
    expect(unscoped.token).toMatch(/^aldn_/);
    const client = await connect(baseURL!, unscoped.token);
    try {
      const created = await call(client, 'create_project', { name: 'MCP Created' });
      expect(created.isError).toBeFalsy();
      expect(created.body).toMatchObject({ name: 'MCP Created', rootFile: 'main.tex', engine: 'pdf', branch: 'main' });
      expect(typeof created.body.id).toBe('string');
      expect(created.body.head).toMatch(/^[0-9a-f]{4,}$/);
      expect(created.body.deepLink).toContain(`/p/${created.body.id}`);

      // visible to the agent and, through the owner's session, to the human
      const list = await call(client, 'list_projects', {});
      const mine = (list.body as Array<any>).find((p) => p.id === created.body.id);
      expect(mine).toBeTruthy();
      expect(mine.name).toBe('MCP Created');
      expect((await myProjects()).some((p) => p.id === created.body.id)).toBeTruthy();
      // the blank seed is a real project the write tools can work on
      const struct = await call(client, 'project_structure', { project: created.body.id });
      expect(struct.body.files.map((f: any) => f.path)).toEqual(expect.arrayContaining(['main.tex', 'references.bib']));

      // from a template, and an unknown template names the available ids
      const slides = await call(client, 'create_project', { name: 'MCP Slides', template: 'beamer' });
      expect(slides.isError).toBeFalsy();
      const slidesStruct = await call(client, 'project_structure', { project: slides.body.id });
      expect(slidesStruct.body.files.some((f: any) => f.path.endsWith('.tex'))).toBeTruthy();
      const unknown = await call(client, 'create_project', { name: 'Nope', template: 'no-such-template' });
      expect(unknown.isError).toBeTruthy();
      expect(unknown.text).toMatch(/Unknown template/);
      expect(unknown.text).toMatch(/beamer/);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
