import { test, expect } from '../fixtures';
import { createPaperProject, openProject, cleanup, expectTypesetOk } from './helpers';

/**
 * Two things a laptop-sized window used to break, both invisible to a suite
 * that only ran at one large size: a dialog taller than its 70vh cap hid its
 * own action row, and the preview toolbar widened the page instead of fitting
 * the pane. Neither shows up in `toBeVisible` — a control clipped by an
 * ancestor's overflow still reports visible — so both assert geometry.
 */

/** Is the element clipped by the scroll box of the dialog it lives in? */
async function clippedByModal(page: import('@playwright/test').Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const modal = el.closest('.modal') as HTMLElement;
    const m = modal.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.bottom > m.bottom + 1 || r.top < m.top - 1;
  }, selector);
}

const SIZES = [
  { w: 1440, h: 900, name: 'laptop' },
  { w: 1280, h: 800, name: 'small laptop' },
  { w: 1180, h: 700, name: 'short window' },
  { w: 1024, h: 640, name: 'very short window' },
];

test.describe('a dialog never hides its own actions', () => {
  for (const s of SIZES) {
    test(`New project keeps Create in view at ${s.name} (${s.w}x${s.h})`, async ({ page, request }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.goto('/');
      await page.getByTestId('new-project').click();
      await expect(page.getByTestId('create-project')).toBeVisible();
      expect(await clippedByModal(page, '[data-testid="create-project"]')).toBe(false);

      // and it works from where it sits, without scrolling the dialog first
      await page.getByTestId('new-project-name').fill(`Fit ${s.w}`);
      await page.getByTestId('create-project').click();
      await expect(page.getByTestId('editor-shell')).toBeVisible();
      await cleanup(request, page.url().split('/p/')[1].split('?')[0]);
    });
  }

  test('project settings keeps Close in view in a short window', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Settings Fit');
    try {
      await page.setViewportSize({ width: 1180, height: 640 });
      await openProject(page, id);
      await page.getByTestId('project-settings-open').click();
      await expect(page.getByTestId('settings-close')).toBeVisible();
      expect(await clippedByModal(page, '[data-testid="settings-close"]')).toBe(false);
    } finally { await cleanup(request, id); }
  });
});

test.describe('the editor never scrolls sideways', () => {
  for (const s of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 700 }, { w: 900, h: 700 }]) {
    test(`no horizontal overflow at ${s.w}x${s.h}`, async ({ page, request }) => {
      // A typeset project is the wide case: the toolbar only grows its status
      // and its Download button once there is a PDF.
      const id = await createPaperProject(request, `Overflow ${s.w}`);
      try {
        await page.setViewportSize({ width: s.w, height: s.h });
        await openProject(page, id);
        await expectTypesetOk(page);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over).toBeLessThanOrEqual(0);
        for (const t of ['engine-select', 'zoom-controls', 'pdf-status']) {
          const b = await page.getByTestId(t).boundingBox();
          if (b) expect(b.x + b.width).toBeLessThanOrEqual(s.w);
        }
      } finally { await cleanup(request, id); }
    });
  }

  test('shrinking the window pulls the preview pane back in', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Resize Fit');
    try {
      await page.setViewportSize({ width: 1600, height: 900 });
      await openProject(page, id);
      await expectTypesetOk(page);
      await page.setViewportSize({ width: 1000, height: 700 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally { await cleanup(request, id); }
  });
});
