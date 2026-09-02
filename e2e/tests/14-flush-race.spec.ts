import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

const MAIN = '\\documentclass{article}\n\\begin{document}\nStable opening line.\n\\end{document}\n';
const NOTES = 'Reviewer notes start here.\n';

/** Settle long enough for the keystrokes to reach the server doc over the
 *  websocket, but well inside the 1.5 s store debounce — so at PUT time they
 *  exist only in memory and the route's flush is what must save them. */
const UNDER_DEBOUNCE_MS = 500;

test.describe('REST writes vs live collab (flush race)', () => {
  test('typing survives an immediate REST write to a sibling file', async ({ page, request }) => {
    const id = await createProject(request, 'Flush Race');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'notes.tex', content: NOTES } });
      // read-modify-write base taken BEFORE any typing happens
      const stale = await (await request.get(`/api/projects/${id}/file?branch=main&path=notes.tex`)).text();

      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.type('TYPED-DURING-RACE ');
      await page.waitForTimeout(UNDER_DEBOUNCE_MS);
      const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'notes.tex', content: stale + 'REST-APPENDED\n' } });
      expect(res.ok()).toBeTruthy();

      // the branch-wide refresh after the write must not wipe the in-memory keystrokes…
      await expect(page.locator('.cm-content')).toContainText('TYPED-DURING-RACE');
      // …and the pre-write flush must have landed them on disk
      const onDisk = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(onDisk).toContain('TYPED-DURING-RACE');
      // the REST write itself is intact
      const notes = await (await request.get(`/api/projects/${id}/file?branch=main&path=notes.tex`)).text();
      expect(notes).toBe(stale + 'REST-APPENDED\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a stale same-file write with baseVersion is refused and loses nothing', async ({ page, request }) => {
    const id = await createProject(request, 'Version Conflict');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const pre = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
      const stale = await pre.text();
      const baseVersion = Number(pre.headers()['x-aldine-content-version']);
      expect(Number.isFinite(baseVersion)).toBeTruthy();

      await openProject(page, id);
      await page.locator('.cm-content').click();
      await page.keyboard.type('KEYSTROKES-TO-KEEP ');
      await page.waitForTimeout(UNDER_DEBOUNCE_MS);

      // the flush inside PUT bumps the version past the pre-typing read → 409
      const res = await request.put(`/api/projects/${id}/file`, {
        data: { branch: 'main', path: 'main.tex', content: stale.replace('Stable', 'Clobbered'), baseVersion },
      });
      expect(res.status()).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('version_conflict');
      expect(body.currentVersion).toBeGreaterThan(baseVersion);

      // the refused write changed nothing: keystrokes live in doc and on disk
      await expect(page.locator('.cm-content')).toContainText('KEYSTROKES-TO-KEEP');
      const onDisk = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(onDisk).toContain('KEYSTROKES-TO-KEEP');
      expect(onDisk).not.toContain('Clobbered');
    } finally {
      await cleanup(request, id);
    }
  });
});
