import { test, expect } from '../fixtures';
import type { APIRequestContext } from '@playwright/test';
import { createProject, cleanup } from './helpers';

/**
 * Page-1 thumbnails for the project list: a successful typeset leaves an
 * image the list row points at, a failed one keeps the previous image, the
 * next good one replaces it, and the trash still shows it.
 */

type Thumb = { branch: string; w: number; h: number; v: string };

// Plain LaTeX, so a local BasicTeX typesets it as well as the image's TeX Live.
const DOC = '\\documentclass{article}\n\\begin{document}\n\\section*{A paper with a thumbnail}\nSome text on page one.\n\\newpage\nPage two.\n\\end{document}\n';

async function rowThumb(request: APIRequestContext, id: string, from = '/api/projects'): Promise<Thumb | null> {
  const rows = (await (await request.get(from)).json()) as Array<{ id: string; thumb?: Thumb | null }>;
  return rows.find((r) => r.id === id)?.thumb ?? null;
}

async function typeset(request: APIRequestContext, id: string): Promise<boolean> {
  const res = await request.post(`/api/projects/${id}/compile`, { data: { branch: 'main' } });
  return (await res.json()).ok as boolean;
}

test.describe('page-1 thumbnails', () => {
  test.beforeEach(async () => {
    // The compiler the suite runs against; with ALDINE_URL it may not be reachable from here.
    const url = process.env.COMPILER_URL || 'http://localhost:4020';
    const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => null);
    test.skip(health?.thumbnails === 'none', 'the compiler has neither gs nor pdftoppm');
  });

  test('a typeset renders page 1; a failed one keeps it; the trash shows it', async ({ request }) => {
    const id = await createProject(request, 'Thumbnail Paper');
    const put = (content: string) => request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
    try {
      expect((await put(DOC)).ok()).toBeTruthy();
      expect(await rowThumb(request, id)).toBeNull();
      expect((await request.get(`/api/projects/${id}/thumbnail?branch=main`)).status()).toBe(404);

      expect(await typeset(request, id)).toBe(true);
      await expect.poll(() => rowThumb(request, id), { timeout: 20_000 }).not.toBeNull();
      const first = (await rowThumb(request, id))!;
      expect(first.branch).toBe('main');
      expect(first.v).toMatch(/^[0-9a-f]{16}$/);
      expect(first.w).toBeGreaterThanOrEqual(340);
      expect(first.w).toBeLessThanOrEqual(380);
      expect(first.h).toBeGreaterThan(first.w);

      const res = await request.get(`/api/projects/${id}/thumbnail?branch=main&v=${first.v}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/jpeg');
      expect(res.headers().etag).toBe(`"${first.v}"`);
      expect(res.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
      const bytes = await res.body();
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      const again = await request.get(`/api/projects/${id}/thumbnail?branch=main&v=${first.v}`, { headers: { 'if-none-match': `"${first.v}"` } });
      expect(again.status()).toBe(304);

      expect((await put(DOC.replace('\\begin{document}', '\\begin{document}\n\\thisisnotacommand'))).ok()).toBeTruthy();
      expect(await typeset(request, id)).toBe(false);
      // Long enough for a render the failed typeset should not have started.
      await new Promise((r) => setTimeout(r, 1500));
      expect((await rowThumb(request, id))?.v).toBe(first.v);

      expect((await put(DOC.replace('\\begin{document}', '\\begin{document}\n\\begin{center}\\Huge A NEW FIRST PAGE\\end{center}'))).ok()).toBeTruthy();
      expect(await typeset(request, id)).toBe(true);
      await expect.poll(async () => (await rowThumb(request, id))?.v, { timeout: 20_000 }).not.toBe(first.v);
      const second = (await rowThumb(request, id))!;

      expect((await request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
      expect(await rowThumb(request, id, '/api/projects/trash')).toEqual(second);
      expect((await request.get(`/api/projects/${id}/thumbnail?branch=main&v=${second.v}`)).status()).toBe(200);
    } finally {
      await cleanup(request, id);
    }
  });
});
