import { test, expect } from '../fixtures';
import { createProject, createPaperProject, openProject, expectTypesetOk, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Six pages, each filled with lines that name their page. */
const PAGES = [
  '\\documentclass{article}',
  '\\begin{document}',
  ...Array.from({ length: 6 }, (_, p) => [
    `\\section*{Page ${p + 1}}`,
    ...Array.from({ length: 30 }, (_, k) => `Words on page ${p + 1}, line ${k + 1}, with enough text to fill the measure.\\par`),
    '\\newpage',
  ].join('\n')),
  '\\end{document}',
  '',
].join('\n');

const zoomLabel = (page: import('@playwright/test').Page) => page.getByTestId('zoom-controls').locator('.zoom__label');

/** In the page: the pages on screen that show no ink, a page drawn white or
 *  not drawn at all. */
function blankOnScreen(pane: HTMLElement): string[] {
  const view = pane.getBoundingClientRect();
  const blank: string[] = [];
  for (const c of pane.querySelectorAll<HTMLCanvasElement>('canvas.pdf-page')) {
    const r = c.getBoundingClientRect();
    if (r.bottom <= view.top || r.top >= view.bottom) continue;
    let ink = false;
    if (c.width && c.height) {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let k = 0; k < d.length && !ink; k += 4) ink = d[k + 3] > 128 && d[k] < 128;
    }
    if (!ink) blank.push(c.dataset.page!);
  }
  return blank;
}

/** In the page: records into window.__blank every page on screen without ink,
 *  checked each frame and the moment the pages are replaced. */
function watchForBlankPages(pane: HTMLElement) {
  const seen: string[] = [];
  (window as unknown as { __blank: string[] }).__blank = seen;
  const inked = new WeakMap<HTMLCanvasElement, number>();
  const view = () => pane.getBoundingClientRect();
  const check = (when: string) => {
    const v = view();
    for (const c of pane.querySelectorAll<HTMLCanvasElement>('canvas.pdf-page')) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= v.top || r.top >= v.bottom) continue;
      if (c.width && inked.get(c) === c.width) continue;
      let ink = false;
      if (c.width && c.height) {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        for (let k = 0; k < d.length && !ink; k += 4) ink = d[k + 3] > 128 && d[k] < 128;
      }
      if (ink) inked.set(c, c.width);
      else if (seen.length < 20) seen.push(`${when}: page ${c.dataset.page}`);
    }
  };
  new MutationObserver(() => check('replaced')).observe(pane.querySelector('.pdf-pane__inner')!, { childList: true });
  const frame = () => { check('frame'); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}

/** The compiled-PDF pane: zoom, reach, focus, width, branches, the log, the jumps and the downloads. */
test.describe('PDF preview', () => {
  test('a zoomed page scrolls to both edges; keys and Ctrl+wheel zoom the pages, not the app', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Pane Zoom');
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      const pane = page.getByTestId('pdf-pane');
      await expect(pane).toHaveAttribute('role', 'region');
      await expect(pane).toHaveAttribute('tabindex', '0');
      // fit width: nothing to scroll sideways
      await expect.poll(() => pane.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

      // + and - step through the zoom steps, from the focused pane
      await pane.focus();
      await page.keyboard.press('+');
      await expect(zoomLabel(page)).toHaveText('125%');
      await page.keyboard.press('+');
      await expect(zoomLabel(page)).toHaveText('150%');

      // the page's left edge is reachable, and so is its right
      const edges = async (left: 'start' | 'end') => pane.evaluate((el, at) => {
        el.scrollLeft = at === 'start' ? 0 : el.scrollWidth;
        const p = el.querySelector('canvas.pdf-page')!.getBoundingClientRect();
        const v = el.getBoundingClientRect();
        return { left: p.left - v.left, right: v.left + el.clientWidth - p.right, overflow: el.scrollWidth - el.clientWidth };
      }, left);
      await expect.poll(async () => (await edges('start')).overflow).toBeGreaterThan(50);
      expect((await edges('start')).left).toBeGreaterThanOrEqual(0);
      expect((await edges('end')).right).toBeGreaterThanOrEqual(0);

      // Ctrl+wheel over the pages zooms them and the browser does not zoom the app
      await page.evaluate(() => {
        (window as any).__wheel = [];
        window.addEventListener('wheel', (e) => (window as any).__wheel.push(e.defaultPrevented));
      });
      const box = (await pane.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await expect(zoomLabel(page)).toHaveText('200%');
      expect(await page.evaluate(() => (window as any).__wheel)).toEqual([true]);

      // 0 is fit width again, - steps below it
      await page.keyboard.press('0');
      await expect(zoomLabel(page)).toHaveText('100%');
      await page.getByTestId('zoom-controls').getByRole('button', { name: 'Zoom out' }).click();
      await expect(zoomLabel(page)).toHaveText('75%');
    } finally { await cleanup(request, id); }
  });

  test('a narrow preview keeps the page reachable from its left edge', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Narrow');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES } });
      await openProject(page, id);
      await expectTypesetOk(page);
      const divider = page.getByTestId('pane-resizer');
      const b = (await divider.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + 100);
      await page.mouse.down();
      await page.mouse.move(b.x + 1200, b.y + 100, { steps: 6 });
      await page.mouse.up();
      await expect(divider).toHaveAttribute('aria-valuenow', '280');
      const pane = page.getByTestId('pdf-pane');
      await expect.poll(() => pane.evaluate((el) => {
        el.scrollLeft = 0;
        return el.querySelector('canvas.pdf-page')!.getBoundingClientRect().left - el.getBoundingClientRect().left;
      })).toBeGreaterThanOrEqual(0);
    } finally { await cleanup(request, id); }
  });

  test('the preview width is remembered, comes back after a narrow window, and resets on double-click', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Width');
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openProject(page, id);
      const preview = page.getByTestId('preview');
      const width = async () => Math.round((await preview.boundingBox())!.width);
      expect(await width()).toBe(576);
      const divider = page.getByTestId('pane-resizer');
      const b = (await divider.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + 100);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 - 124, b.y + 100, { steps: 6 });
      await page.mouse.up();
      expect(await width()).toBe(700);

      await page.reload();
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      expect(await width()).toBe(700);

      // A narrower window takes the room it needs; the chosen width returns with the room.
      await page.setViewportSize({ width: 1000, height: 800 });
      await expect.poll(width).toBeLessThan(700);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(width).toBe(700);

      await divider.dblclick();
      expect(await width()).toBe(576);
      expect(await page.evaluate(() => localStorage.getItem('aldine.pdfWidth'))).toBeNull();
    } finally { await cleanup(request, id); }
  });

  test('with Auto on, switching branches shows that branch’s PDF, and switching back shows the first one again', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Pane Branches');
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'revision' } })).ok()).toBe(true);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-revision').click();
      await expect(page).toHaveURL(/branch=revision/);
      await expect(page.getByTestId('preview')).toHaveAttribute('data-pdf', /branch=revision/, { timeout: 120_000 });
      await expectTypesetOk(page);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-main').click();
      await expect(page).not.toHaveURL(/branch=revision/);
      await expect(page.getByTestId('preview')).toHaveAttribute('data-pdf', /branch=main/, { timeout: 120_000 });
      await expectTypesetOk(page);
    } finally { await cleanup(request, id); }
  });

  test('a branch switch while a typeset runs still typesets the branch switched to', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Pane Busy Switch');
    try {
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      await openProject(page, id);
      await expect(page.getByTestId('typeset-button')).toHaveAttribute('aria-busy', 'true', { timeout: 20_000 });
      await page.getByTestId('branch-menu').click();
      await page.getByTestId('branch-draft').click();
      await expect(page).toHaveURL(/branch=draft/);
      await expect(page.getByTestId('preview')).toHaveAttribute('data-pdf', /branch=draft/, { timeout: 120_000 });
      await expectTypesetOk(page);
    } finally { await cleanup(request, id); }
  });

  test('with the stale banner pinned, a followed link and a typed page land below it, not under it', async ({ page, request }) => {
    const doc = [
      '\\documentclass{article}', '\\usepackage{hyperref}', '\\begin{document}',
      'The target is Section~\\ref{sec:target}.', '', 'More words on the first page.', '\\newpage',
      'The second page opens with a paragraph before the heading.', '\\section{Target}\\label{sec:target}',
      'The section the reference points at.', '\\newpage', 'A third page.', '\\newpage', 'A fourth page.', '\\end{document}', '',
    ].join('\n');
    const id = await createProject(request, 'Pane Stale Jumps');
    try {
      // halting mode: the failed run leaves no PDF, so the last one stays, flagged
      await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc.replace('More words', '\\nosuchmacro More words') } });
      await page.getByTestId('typeset-button').click();
      await expect(page.getByTestId('pdf-stale')).toBeVisible({ timeout: 60_000 });

      const pane = page.getByTestId('pdf-pane');
      const below = (selector: string) => pane.evaluate((el, sel) => {
        const banner = el.querySelector('.pdf-stale')!.getBoundingClientRect();
        return el.querySelector(sel)!.getBoundingClientRect().top - banner.bottom;
      }, selector);
      await page.getByRole('button', { name: 'Go to page 2' }).click();
      await expect(page.locator('.pdf-flash')).toHaveCount(1);
      // the pane scrolls to the target over a few frames
      await expect.poll(() => below('.pdf-flash')).toBeLessThan(24);
      expect(await below('.pdf-flash')).toBeGreaterThan(4);

      await page.getByTestId('pdf-page-indicator').click();
      await page.getByTestId('pdf-page-input').fill('3');
      await page.keyboard.press('Enter');
      await expect.poll(() => below('canvas[data-page="3"]')).toBeLessThan(16);
      expect(await below('canvas[data-page="3"]')).toBeGreaterThanOrEqual(0);
    } finally { await cleanup(request, id); }
  });

  test('the log opens after a clean run; a one-file project’s warnings jump to their line', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Log');
    const lines = ['\\documentclass{article}', '\\begin{document}', 'Some text.', '', 'A claim \\cite{nobody2020} with no source.', '\\end{document}', ''];
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: lines.join('\n') } });
      await openProject(page, id);
      await expectTypesetOk(page);

      // the status line opens the log
      await page.getByTestId('pdf-status-log').click();
      await expect(page.getByTestId('log-view')).toContainText('nobody2020');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('log-view')).toHaveCount(0);

      // so does the palette
      await page.locator('.cm-content').click();
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('palette-input').fill('typesetting log');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('log-view')).toBeVisible();
      await page.keyboard.press('Escape');

      // the undefined citation is a warning on line 5 of the only .tex
      const toggle = page.getByTestId('problems-toggle');
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      const row = page.getByTestId('problem-warning').filter({ hasText: 'nobody2020' });
      await row.locator('button.errors__jump').click();
      await expect(page.locator('.cm-activeLine')).toContainText('nobody2020');

      // no bibliography, no .bbl to offer; the log is there
      await page.getByTestId('share-project').click();
      await expect(page.getByTestId('download-log')).toHaveText('main.log');
      await expect(page.getByTestId('download-bbl')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('Jump to source, from the header and the palette, opens the line in the middle of the preview', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Source');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);

      await page.getByTestId('pdf-page-indicator').click();
      await page.getByTestId('pdf-page-input').fill('3');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('pdf-page-indicator')).toHaveText('3 / 6');
      await page.getByTestId('jump-to-source').click();
      await expect(page.locator('.cm-activeLine')).toContainText('Words on page 3,', { timeout: 10_000 });

      await page.getByTestId('pdf-page-indicator').click();
      await page.getByTestId('pdf-page-input').fill('5');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('pdf-page-indicator')).toHaveText('5 / 6');
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('palette-input').fill('jump to source');
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-activeLine')).toContainText('Words on page 5,', { timeout: 10_000 });
    } finally { await cleanup(request, id); }
  });

  test('Share offers the .bbl arXiv asks for, through the output route', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Pane Bbl');
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      await page.getByTestId('share-project').click();
      const bbl = page.getByTestId('download-bbl');
      await expect(bbl).toHaveText('main.bbl');
      await expect(bbl).toHaveAttribute('download', 'main.bbl');
      const href = (await bbl.getAttribute('href'))!;
      expect(href).toMatch(/\/api\/projects\/[^/]+\/output\?.*path=\.aldine-out%2Fmain\.bbl/);
      const res = await request.get(href);
      expect(res.ok()).toBe(true);
      expect(await res.text()).toContain('\\begin{thebibliography}');
      await expect(page.getByTestId('download-log')).toHaveText('main.log');
      await expect(page.getByTestId('share-downloads')).toContainText('arXiv also needs main.bbl');
    } finally { await cleanup(request, id); }
  });

  test('a typeset PDF that cannot be opened says so and offers the download', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Load Error');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n' } });
      await page.route((url) => url.pathname.endsWith('/output') && !!url.searchParams.get('path')?.endsWith('.pdf'), (route) => route.fulfill({ status: 500, body: 'broken' }));
      await openProject(page, id);
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      await expect(page.getByTestId('pdf-load-error')).toContainText('Could not open the typeset PDF');
      const pdf = await page.getByTestId('preview').getAttribute('data-pdf');
      await expect(page.getByTestId('pdf-load-error-download')).toHaveAttribute('href', pdf!);
      await expect(page.getByTestId('pdf-pane')).not.toContainText('to typeset and preview');
    } finally { await cleanup(request, id); }
  });

  test('zooming and a wider preview keep the page being read, and never fetch the PDF again', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Zoom Hold');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES } });
      let fetches = 0;
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith('/output') && u.searchParams.get('path')?.endsWith('.pdf')) fetches++;
      });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);
      const indicator = page.getByTestId('pdf-page-indicator');
      await indicator.click();
      await page.getByTestId('pdf-page-input').fill('3');
      await page.keyboard.press('Enter');
      await expect(indicator).toHaveText('3 / 6');
      const fetched = fetches;
      expect(fetched).toBeGreaterThan(0);

      const pane = page.getByTestId('pdf-pane');
      const page3 = page.locator('canvas[data-page="3"]');
      // drawn at the size it shows: the zoom has settled into a layout
      const sharp = () => page3.evaluate((c: HTMLCanvasElement) => Math.abs(c.width / (c.clientWidth * Math.min(devicePixelRatio || 1, 2)) - 1) < 0.02);
      const inMiddle = () => pane.evaluate((el) => {
        const y = el.getBoundingClientRect().top + el.clientHeight / 2;
        const r = el.querySelector('canvas[data-page="3"]')!.getBoundingClientRect();
        return r.top <= y && r.bottom >= y;
      });

      await pane.focus();
      for (const [key, label] of [['+', '125%'], ['+', '150%'], ['+', '200%'], ['0', '100%'], ['-', '75%'], ['-', '50%'], ['0', '100%']]) {
        await page.keyboard.press(key);
        await expect(zoomLabel(page)).toHaveText(label);
        await expect.poll(sharp).toBe(true);
        await expect(indicator).toHaveText('3 / 6');
        expect(await inMiddle()).toBe(true);
      }

      // a wider preview lays the pages out again around the same spot
      await page3.evaluate((el) => { el.dataset.before = '1'; });
      const divider = page.getByTestId('pane-resizer');
      const b = (await divider.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + 100);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 - 200, b.y + 100, { steps: 6 });
      await page.mouse.up();
      await expect(page.locator('canvas.pdf-page[data-before]')).toHaveCount(0);
      await expect(indicator).toHaveText('3 / 6');
      expect(await inMiddle()).toBe(true);

      expect(fetches).toBe(fetched);
    } finally { await cleanup(request, id); }
  });

  test('an auto-typeset after an edit stays on the page being read, and its pages never show blank', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Swap');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES } });
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);
      const indicator = page.getByTestId('pdf-page-indicator');
      await indicator.click();
      await page.getByTestId('pdf-page-input').fill('4');
      await page.keyboard.press('Enter');
      await expect(indicator).toHaveText('4 / 6');

      const pane = page.getByTestId('pdf-pane');
      await expect.poll(() => pane.evaluate(blankOnScreen)).toEqual([]);
      const offset = () => pane.evaluate((el) => el.querySelector('canvas[data-page="4"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top);
      const before = await offset();
      const pdf = (await page.getByTestId('preview').getAttribute('data-pdf'))!;
      await page.locator('canvas.pdf-page').evaluateAll((els) => { for (const el of els) (el as HTMLElement).dataset.before = '1'; });
      await pane.evaluate(watchForBlankPages);

      await page.locator('.cm-line', { hasText: '\\section*{Page 1}' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' revised');
      await expect(page.getByTestId('preview')).not.toHaveAttribute('data-pdf', pdf, { timeout: 60_000 });
      await expect(page.locator('canvas.pdf-page[data-before]')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);
      await expect(indicator).toHaveText('4 / 6');
      expect(Math.abs((await offset()) - before)).toBeLessThan(3);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as unknown as { __blank: string[] }).__blank)).toEqual([]);
    } finally { await cleanup(request, id); }
  });

  test('after a run that stopped at an error, the last good pages still draw as they come on screen', async ({ page, request }) => {
    const id = await createProject(request, 'Pane Halted');
    try {
      await page.addInitScript(() => window.localStorage.setItem('aldine.autoTypeset', '0'));
      await request.patch(`/api/projects/${id}`, { data: { stopOnFirstError: true } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES } });
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expectTypesetOk(page);
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);

      // an error after pages have shipped out: pdfTeX deletes the PDF, the run has none
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: PAGES.replace('Words on page 4, line 1,', '\\nosuchmacro Words on page 4, line 1,') } });
      const halted = page.waitForResponse((r) => r.url().includes('/compile') && r.request().method() === 'POST');
      await page.getByTestId('typeset-button').click();
      expect((await (await halted).json()).pdfUrl).toBeNull();
      await expect(page.getByTestId('pdf-stale')).toBeVisible();
      await expect(page.locator('canvas.pdf-page')).toHaveCount(6);

      // a zoom lays the pages out again, and the last page draws once it is on screen
      const pane = page.getByTestId('pdf-pane');
      await pane.focus();
      await page.keyboard.press('+');
      await expect(zoomLabel(page)).toHaveText('125%');
      await expect.poll(() => page.locator('canvas[data-page="1"]').evaluate((c: HTMLCanvasElement) => c.width / c.clientWidth)).toBeGreaterThan(0.95);
      const indicator = page.getByTestId('pdf-page-indicator');
      await indicator.click();
      await page.getByTestId('pdf-page-input').fill('6');
      await page.keyboard.press('Enter');
      await expect(indicator).toHaveText('6 / 6');
      await expect.poll(() => pane.evaluate(blankOnScreen)).toEqual([]);
    } finally { await cleanup(request, id); }
  });
});
