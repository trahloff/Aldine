import { test, expect } from '../fixtures';
import type { APIRequestContext, Browser, BrowserContext } from '@playwright/test';

/**
 * Typesetting in the browser with accounts on: the TeX build and on-demand
 * packages go only to signed-in people; a view-only collaborator typesets in
 * their own tab but cannot change the PDF the branch shows, and neither can
 * an access token; the owner's runs are published.
 */

const AUTH = process.env.ALDINE_BROWSER_TEX_AUTH_URL || `http://localhost:${process.env.E2E_BROWSER_TEX_AUTH_PORT || 3411}`;
const DOC = '\\documentclass{article}\n\\begin{document}\nHello from a viewer test.\n\\end{document}\n';
let n = 0;
const uniq = () => `browser-tex-${Date.now()}-${n++}@example.com`;

async function account(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: AUTH, viewport: { width: 1440, height: 900 } });
  const res = await ctx.request.post('/api/auth/register', { data: { email: uniq(), password: 'password123', name } });
  expect(res.ok(), await res.text()).toBe(true);
  return ctx;
}

/** A publish body (apps/server/src/browsertex/bundle.ts framing). */
function bundle(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const d = Buffer.from(data, 'latin1');
    const head = Buffer.alloc(4); head.writeUInt32BE(n.length);
    const size = Buffer.alloc(4); size.writeUInt32BE(d.length);
    parts.push(head, n, size, d);
  }
  return Buffer.concat(parts);
}

async function publish(request: APIRequestContext, id: string, headers: Record<string, string> = {}) {
  return request.post(`/api/projects/${id}/compile/publish`, {
    headers: { 'content-type': 'application/x-aldine-bundle', ...headers },
    data: bundle([['meta', JSON.stringify({ branch: 'main', rootFile: 'main.tex', exitCode: 0 })], ['pdf', '%PDF-1.5\n% stand-in\n'], ['log', '']]),
  });
}

test.describe('typesetting in the browser, with accounts', () => {
  test('the TeX build and packages go to signed-in people only', async ({ browser }) => {
    const anon = await browser.newContext({ baseURL: AUTH });
    const alice = await account(browser, 'Alice');
    try {
      expect((await anon.request.get('/api/typeset')).status()).toBe(401);
      const info = await (await alice.request.get('/api/typeset')).json();
      expect(info.mode).toBe('browser');
      expect((await anon.request.get(`${info.assets.base}busytex.wasm`)).status()).toBe(401);
      expect((await alice.request.get(`${info.assets.base}busytex_worker.js`)).status()).toBe(200);
      expect((await anon.request.get('/api/texlive/26/tikz.sty')).status()).toBe(401);
      expect((await anon.request.post('/api/typeset/parse', { data: { log: '' } })).status()).toBe(401);
    } finally {
      await anon.close();
      await alice.close();
    }
  });

  test('a viewer typesets in their own tab but never publishes; a token cannot either', async ({ browser }) => {
    const alice = await account(browser, 'Alice');
    const bob = await account(browser, 'Bob');
    try {
      const proj = await (await alice.request.post('/api/projects', { data: { name: 'Viewer test' } })).json();
      expect((await alice.request.put(`/api/projects/${proj.id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } })).ok()).toBe(true);
      expect((await alice.request.post(`/api/projects/${proj.id}/share`, { data: { mode: 'link', linkRole: 'view', collaborators: [] } })).ok()).toBe(true);

      // The server side of a viewer's typeset: a snapshot yes, a publish no.
      expect((await bob.request.get(`/api/projects/${proj.id}/compile/snapshot?branch=main`)).status()).toBe(200);
      expect((await publish(bob.request, proj.id)).status()).toBe(403);

      // In the editor, the viewer's typeset runs and shows in their tab only.
      const page = await bob.newPage();
      await page.goto(`/p/${proj.id}`);
      await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 150_000 });
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible();
      await page.waitForTimeout(12_000);
      const st = await (await alice.request.get(`/api/projects/${proj.id}/compile-status?branch=main`)).json();
      expect(st.result).toBeNull();

      // An access token is a project credential, not someone who may publish.
      const { token } = await (await alice.request.post('/api/tokens', { data: { name: 'browser-tex', projectIds: [proj.id] } })).json();
      const anon = await browser.newContext({ baseURL: AUTH });
      expect((await publish(anon.request, proj.id, { authorization: `Bearer ${token}` })).status()).toBe(403);
      await anon.close();

      // The owner's run is the one the branch shows.
      const own = await publish(alice.request, proj.id);
      expect(own.status()).toBe(200);
      expect((await own.json()).ok).toBe(true);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});
