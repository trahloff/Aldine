import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import zlib from 'node:zlib';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Jumps into a long document land on screen (#338): a SyncTeX double-click,
 * a deep link and an Outline click scroll the editor so the target line is
 * inside the viewport, in Source and in Visual, where tables, TikZ and
 * display math render at heights CodeMirror can only guess before it has
 * drawn them.
 */

const para = (n: number) =>
  `Paragraph ${n} carries enough running text to wrap across several visual lines in the editor pane, ` +
  'so that the heights CodeMirror estimates for lines it has not drawn yet differ from the heights it measures once they are drawn. ' +
  'More words follow here to make the wrapping certain at any reasonable pane width, and then a few more for good measure.';

const table = (n: number) => [
  '\\begin{table}[h]',
  '\\centering',
  '\\begin{tabular}{lrrr}',
  '\\toprule',
  'Item & A & B & C \\\\',
  '\\midrule',
  ...Array.from({ length: 40 }, (_, r) => `Row ${n}.${r + 1} & ${r} & ${r * 2} & ${r * 3} \\\\`),
  '\\bottomrule',
  '\\end{tabular}',
  `\\caption{Table ${n}}`,
  `\\label{tab:t${n}}`,
  '\\end{table}',
];

const tikz = (n: number) => [
  '\\begin{figure}[h]',
  '\\centering',
  '\\begin{tikzpicture}',
  ...Array.from({ length: 10 }, (_, k) => `  \\draw (${k},0) -- (${k},${(k % 4) + 1}) node[above] {${n}.${k}};`),
  '\\end{tikzpicture}',
  `\\caption{Picture ${n}}`,
  '\\end{figure}',
];

const photo = (name: string, n: number) => [
  '\\begin{figure}[h]',
  '\\centering',
  `\\includegraphics[width=0.5\\linewidth]{photo-${name}}`,
  `\\caption{Photo ${n}}`,
  '\\end{figure}',
];

/** A solid w×h RGB PNG: tall enough that a figure preview changes a line's height once it loads. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const maths = (n: number) => [
  '\\begin{align}',
  `  f_{${n}}(x) &= \\sum_{k=0}^{\\infty} \\frac{x^k}{k!} \\\\`,
  `  g_{${n}}(x) &= \\int_0^x \\frac{\\sin t}{t}\\,dt \\\\`,
  `  h_{${n}}(x) &= \\prod_{k=1}^{n} \\left(1 + \\frac{x}{k}\\right)`,
  '\\end{align}',
];

/** ~1300 lines, ~25 pages: sections of wrapped prose, tables, TikZ and display math. */
function chapter(prefix: string, sections: number): string[] {
  const out: string[] = [];
  for (let s = 1; s <= sections; s++) {
    out.push(`\\section{${prefix} section ${s}}`, '');
    for (let p = 1; p <= 4; p++) out.push(para(s * 10 + p), '');
    out.push(...table(s), '');
    out.push(para(s * 10 + 5), '');
    out.push(...tikz(s), '');
    out.push(...photo(`${prefix}-${s}`, s), '');
    out.push(...maths(s), '');
    out.push(`${prefix} target ${s} is this line.`, '');
  }
  return out;
}

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\usepackage{booktabs}',
  '\\usepackage{tikz}',
  '\\begin{document}',
  ...chapter('Main', 18),
  '\\input{tables}',
  '\\end{document}',
  '',
].join('\n');
const TABLES = [...chapter('Input', 12), ''].join('\n');

const lineOf = (doc: string, text: string) => doc.split('\n').findIndex((l) => l.includes(text)) + 1;

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  for (const [path, content] of Object.entries({ 'main.tex': MAIN, 'tables.tex': TABLES })) {
    const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
    expect(res.ok()).toBeTruthy();
  }
  const image = png(600, 400).toString('base64');
  for (const name of [...Array.from({ length: 18 }, (_, k) => `Main-${k + 1}`), ...Array.from({ length: 12 }, (_, k) => `Input-${k + 1}`)]) {
    const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: `photo-${name}.png`, content: image, encoding: 'base64' } });
    expect(res.ok()).toBeTruthy();
  }
  return id;
}

/** The caret is drawn well inside the editor's scroller, and stays there. */
async function expectCaretOnScreen(page: Page, text?: string) {
  if (text) await expect(page.locator('.cm-activeLine')).toContainText(text);
  await expect.poll(async () => {
    const read = () => page.evaluate(() => {
      const caret = document.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
      const scroller = document.querySelector('.cm-scroller');
      if (!caret || !scroller) return 'no caret';
      // Clear of the edges, unless the text cannot scroll any further that way.
      const box = scroller.getBoundingClientRect();
      const edge = box.height * 0.15;
      const high = caret.top < box.top + edge && scroller.scrollTop > 1;
      const low = caret.bottom > box.bottom - edge && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      return high || low ? `at ${Math.round(caret.top - box.top)}px of ${Math.round(box.height)}` : 'on screen';
    });
    // Settled, not passing through: the same answer twice, a moment apart.
    const a = await read();
    await page.waitForTimeout(150);
    const b = await read();
    return a === b ? a : 'moving';
  }, { timeout: 10_000 }).toBe('on screen');
}

async function scrollTop(page: Page) {
  await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 0; });
}

for (const mode of ['source', 'visual'] as const) {
  test.describe(`jumps in a long document (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      // Figure previews arrive a moment after the text, as over a real network.
      await page.route(/\/file\?.*path=photo/, async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue(); });
      await page.addInitScript((m) => { localStorage.setItem('aldine.editorMode', m); localStorage.setItem('aldine.autoTypeset', '0'); }, mode);
    });

    test('an Outline click puts the heading on screen', async ({ page, request }) => {
      const id = await seed(request, `Outline jump ${mode}`);
      try {
        await openProject(page, id);
        const items = page.getByTestId('outline-item');
        await expect(items).toHaveCount(18);
        // Straight away, while Visual is still drawing what it renders, and
        // again once everything has been drawn.
        for (const [i, n] of [14, 18, 3, 11].entries()) {
          if (i) await scrollTop(page);
          await items.nth(n - 1).click();
          await expectCaretOnScreen(page, `Main section ${n}`);
        }
      } finally {
        await cleanup(request, id);
      }
    });

    test('a deep link to a line puts it on screen', async ({ page, request }) => {
      const id = await seed(request, `Deep link jump ${mode}`);
      try {
        const target = lineOf(MAIN, 'Main target 15 is');
        await page.goto(`/p/${id}?line=${target}`);
        await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
        await expectCaretOnScreen(page, 'Main target 15 is');
      } finally {
        await cleanup(request, id);
      }
    });

    test('a SyncTeX double-click puts the source line on screen, in the root and in an \\input file', async ({ page, request }) => {
      const id = await seed(request, `SyncTeX jump ${mode}`);
      try {
        await openProject(page, id);
        await page.getByTestId('typeset-button').click();
        const pages = page.locator('canvas.pdf-page');
        await expect(pages.first()).toBeVisible({ timeout: 120_000 });
        await expect.poll(() => pages.count(), { timeout: 30_000 }).toBeGreaterThan(20);

        const dblclickPage = async (n: number) => {
          const canvas = pages.nth(n);
          await canvas.scrollIntoViewIfNeeded();
          const box = (await canvas.boundingBox())!;
          await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.4);
        };
        // The outline marks the heading the caret is under.
        const section = async () => Number(/(\d+)$/.exec((await page.locator('[data-testid="outline-item"][aria-current="location"]').textContent({ timeout: 1000 }).catch(() => '')) ?? '')?.[1] ?? 0);

        const last = (await pages.count()) - 2;

        // Straight after opening the project on the last typeset's PDF, into
        // the \input file: the jump opens it, and lands while Visual is still
        // drawing it.
        await page.reload();
        await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
        await expect(pages.nth(last)).toBeAttached({ timeout: 30_000 });
        await dblclickPage(last);
        await expect(page.getByTestId('outline-item').first()).toHaveText('Input section 1', { timeout: 10_000 });
        await expect.poll(section).toBeGreaterThan(5);
        await expectCaretOnScreen(page);

        // Back deep into the root file.
        await dblclickPage(15);
        await expect(page.getByTestId('outline-item').first()).toHaveText('Main section 1', { timeout: 10_000 });
        await expect.poll(section).toBeGreaterThan(5);
        await expectCaretOnScreen(page);

        // Into the \input file again, last left near its top: the jump beats
        // the kept scroll position.
        await page.getByTestId('file-tables.tex').click();
        await expect(page.getByTestId('outline-item').first()).toHaveText('Input section 1');
        await scrollTop(page);
        const sb = (await page.locator('.cm-scroller').boundingBox())!;
        await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await page.getByTestId('file-main.tex').click();
        await expect(page.getByTestId('outline-item').first()).toHaveText('Main section 1');
        await dblclickPage(last);
        await expect(page.getByTestId('outline-item').first()).toHaveText('Input section 1', { timeout: 10_000 });
        await expect.poll(section).toBeGreaterThan(5);
        await expectCaretOnScreen(page);
      } finally {
        await cleanup(request, id);
      }
    });
  });
}

test.describe('a jump while the source still coasts (#338)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('aldine.editorMode', 'source'); localStorage.setItem('aldine.autoTypeset', '0'); });
  });

  test('wheel events from a scroll begun over the editor do not carry it off the target', async ({ page, request }) => {
    const id = await seed(request, 'Coasting jump');
    try {
      await openProject(page, id);
      const items = page.getByTestId('outline-item');
      await expect(items).toHaveCount(18);
      const item = items.nth(13);
      const at = (await item.boundingBox())!;
      // A trackpad's momentum: the scroller the gesture began on keeps getting
      // its wheel events, at wherever the pointer is now, and keeps scrolling.
      await page.locator('.cm-scroller').evaluate((el, p) => new Promise<void>((started) => {
        const t0 = performance.now();
        const step = () => {
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, clientX: p.x, clientY: p.y, bubbles: true }));
          el.scrollTop += 60;
          if (performance.now() - t0 < 2000) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        setTimeout(started, 200);
      }), { x: at.x + at.width / 2, y: at.y + at.height / 2 });
      await item.click();
      await page.waitForTimeout(2000);
      await expectCaretOnScreen(page, 'Main section 14');

      // A wheel over the editor is the reader's own: the jump lets go.
      await items.nth(2).click();
      await expectCaretOnScreen(page, 'Main section 3');
      const sb = (await page.locator('.cm-scroller').boundingBox())!;
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.mouse.wheel(0, 6000);
      await expect.poll(() => page.evaluate(() => {
        const caret = document.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
        const box = document.querySelector('.cm-scroller')!.getBoundingClientRect();
        return !caret || caret.bottom < box.top;
      })).toBe(true);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => {
        const caret = document.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
        const box = document.querySelector('.cm-scroller')!.getBoundingClientRect();
        return !caret || caret.bottom < box.top;
      })).toBe(true);
    } finally {
      await cleanup(request, id);
    }
  });
});

/**
 * acmart and its kind keep the title block until \maketitle typesets it, so
 * SyncTeX answers with the \maketitle line for a double-click on the
 * abstract. This package stores and typesets it the same way, and adds a
 * line of its own as acmart adds its reference format; any TeX Live can
 * compile it.
 */
const TITLE_STY = [
  '\\long\\def\\storeabstract#1{\\long\\gdef\\@storedabstract{#1}}',
  '\\renewcommand\\maketitle{\\noindent Reference format printed by the class.\\par\\@storedabstract\\par}',
  '',
].join('\n');
const TITLE_BLOCK = [
  '\\documentclass{article}',
  '\\usepackage{titleblock}',
  '\\begin{document}',
  '\\storeabstract{%',
  'Coastal wetlands store carbon in their sediments for centuries.',
  '}',
  ...Array.from({ length: 300 }, (_, k) => `% filler ${k} keeps the abstract far above the body`),
  '\\maketitle',
  ...Array.from({ length: 40 }, (_, k) => [`\\section{Part ${k + 1}}`, para(k), '']).flat(),
  '\\end{document}',
  '',
].join('\n');

test.describe('a double-click on a title block that \\maketitle typesets (#338)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('aldine.editorMode', 'source'); localStorage.setItem('aldine.autoTypeset', '0'); });
  });

  test('lands on the source line of the clicked text, or says why it lands on \\maketitle', async ({ page, request }) => {
    const id = await createProject(request, 'Title block jump');
    try {
      for (const [path, content] of Object.entries({ 'main.tex': TITLE_BLOCK, 'titleblock.sty': TITLE_STY })) {
        const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
        expect(res.ok()).toBeTruthy();
      }
      await openProject(page, id);
      await page.getByTestId('typeset-button').click();
      await expect(page.locator('canvas.pdf-page').first()).toBeVisible({ timeout: 120_000 });
      const span = (text: string) => page.getByTestId('pdf-text').first().locator('span', { hasText: text }).first();

      // From the far end of the source.
      await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await span('Coastal wetlands').dblclick();
      await expectCaretOnScreen(page, 'Coastal wetlands store carbon');

      await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await span('Reference format').dblclick();
      await expect(page.getByText('This part of the title block is typeset by \\maketitle, so the jump lands there')).toBeVisible();
      await expectCaretOnScreen(page, '\\maketitle');
    } finally {
      await cleanup(request, id);
    }
  });
});
