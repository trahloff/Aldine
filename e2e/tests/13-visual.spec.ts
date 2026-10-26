import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

const DOC = [
  '\\section{Introduction}',
  'Hello \\textbf{brave} new \\emph{world} of text.',
  '',
  '\\subsection{Details}',
  'More prose here.',
  '',
].join('\n');

test.describe('the Source/Visual switch', () => {
  test('a fresh browser opens a document as source with the switch shown, and the last choice sticks after reload', async ({ page, request }) => {
    const id = await createProject(request, 'Visual Switch');
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
    const toggle = page.getByTestId('mode-toggle');
    const selected = (name: 'Source' | 'Visual') => expect(page.getByTestId(`mode-${name.toLowerCase()}`)).toHaveAttribute('aria-pressed', 'true');
    try {
      await openProject(page, id);
      await expect(toggle).toBeVisible();
      await selected('Source');
      await expect(page.locator('.cm-content')).toContainText('Hello \\textbf{brave} new');
      await expect(page.getByTestId('format-toolbar')).toHaveCount(0);
      await expect(toggle).toHaveAttribute('role', 'group');

      // the switch hands the keyboard back to the text, the caret where it was
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await page.keyboard.press('End');
      await page.getByTestId('mode-visual').click();
      await expect(page.locator('.cm-vis-b')).toContainText('brave');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.type('!');
      await expectStored(request, id, DOC.replace('More prose here.', 'More prose here.!'));
      await page.reload();
      await expect(page.locator('.cm-content')).toBeVisible();
      await selected('Visual');
      await expect(page.locator('.cm-vis-b')).toContainText('brave');
      await expect(page.getByTestId('format-toolbar')).toBeVisible();

      // the flag from the experimental period changes nothing, '0' included
      await page.evaluate(() => window.localStorage.setItem('aldine.experimental.visualEditor', '0'));
      await page.reload();
      await expect(toggle).toBeVisible();
      await selected('Visual');
      await expect(page.locator('.cm-vis-b')).toContainText('brave');

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('editing');
      await expect(page.getByTestId('palette-item-mode')).toHaveText(/Switch to Source editing/);
      await expect(page.getByTestId('palette-item-experimental-visual')).toHaveCount(0);
      await page.getByTestId('palette-item-mode').click();
      await selected('Source');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.type('?');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/\?/);
      await page.reload();
      await expect(page.locator('.cm-content')).toBeVisible();
      await selected('Source');
      await expect(page.locator('.cm-content')).toContainText('Hello \\textbf{brave} new');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('visual editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  async function seed(request: Parameters<typeof createProject>[0], name: string) {
    const id = await createProject(request, name);
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
    return id;
  }

  test('renders headings and styles, toggles back to source without remount', async ({ page, request }) => {
    const id = await seed(request, 'Visual Render');
    try {
      await openProject(page, id);
      // park the caret in plain prose — the construct under the caret is
      // (correctly) revealed as source, and a fresh doc opens with caret at 0
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      // markup hidden, content rendered
      await expect(page.locator('.cm-content')).toContainText('Introduction');
      await expect(page.locator('.cm-content')).not.toContainText('\\section{');
      await expect(page.locator('.cm-vis-h1')).toHaveCount(1);
      await expect(page.locator('.cm-vis-h2')).toHaveCount(1);
      await expect(page.locator('.cm-vis-b')).toContainText('brave');
      await expect(page.locator('.cm-vis-i')).toContainText('world');

      // tag the editor DOM, toggle to Source — same DOM node must survive (no remount)
      await page.evaluate(() => { document.querySelector('.cm-content')!.setAttribute('data-mounted', 'once'); });
      await page.getByTestId('mode-source').click();
      await expect(page.locator('.cm-content')).toContainText('\\section{Introduction}');
      await expect(page.locator('.cm-content[data-mounted="once"]')).toHaveCount(1);

      // and back
      await page.getByTestId('mode-visual').click();
      await expect(page.locator('.cm-content')).not.toContainText('\\section{');
      await expect(page.locator('.cm-content[data-mounted="once"]')).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('cursor-reveal shows source for the construct under the caret', async ({ page, request }) => {
    const id = await seed(request, 'Visual Reveal');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await expect(page.locator('.cm-vis-b')).toContainText('brave');
      await page.locator('.cm-vis-b').click();
      // the bold construct un-renders: raw markup visible
      await expect(page.locator('.cm-content')).toContainText('\\textbf{brave}');
      // click into plain prose → re-renders
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await expect(page.locator('.cm-content')).not.toContainText('\\textbf{');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a visual-mode cursor tour never changes a byte of source', async ({ page, request }) => {
    const id = await seed(request, 'Visual Bytes');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await expect(page.locator('.cm-vis-h1')).toHaveCount(1);
      // tour: click into every construct, arrow across atomic boundaries
      for (const target of ['.cm-vis-b', '.cm-vis-i', '.cm-vis-h1', '.cm-vis-h2'] as const) {
        await page.locator(target).first().click({ force: true }).catch(() => {});
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
      }
      await page.keyboard.press('End');
      await page.keyboard.press('Home');
      // let the collab layer flush any (nonexistent) writes
      await page.waitForTimeout(3000);
      const res = await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`);
      expect(await res.text()).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });

  test('math renders via KaTeX and click reveals its source', async ({ page, request }) => {
    const id = await createProject(request, 'Visual Math');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'Euler: $e^{i\\pi} + 1 = 0$ stays true.\n\\[ \\int_0^1 x^2 \\, dx = \\tfrac{1}{3} \\]\nplain end\n' } });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-math')).toHaveCount(2);
      await expect(page.locator('.katex').first()).toBeVisible();
      // (innerText: the MathML copy for screen readers carries the TeX as an annotation)
      await expect(page.locator('.cm-content')).not.toContainText('e^{i\\pi}', { useInnerText: true });
      // click the inline equation → the MathLive editor opens
      await page.getByTestId('vis-math').first().click();
      await expect(page.getByTestId('math-popover')).toBeVisible();
      // editing through the math field writes back a precise source edit
      await page.evaluate(() => {
        (document.querySelector('[data-testid="math-field"]') as HTMLElement & { value: string }).value = 'e^{i\\pi} + 2 = 1';
      });
      await page.getByTestId('math-popover-done').click();
      await page.waitForTimeout(2500);
      const edited = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(edited).toContain('$e^{i\\pi} + 2 = 1$');
      // the "TeX" button drops into raw source instead
      await page.getByTestId('vis-math').first().click();
      await page.getByTestId('math-popover-source').click();
      await expect(page.locator('.cm-content')).toContainText('$e^{i\\pi} + 2 = 1$');
      // leave → re-rendered
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.locator('.cm-content')).not.toContainText('e^{i\\pi}', { useInnerText: true });
    } finally {
      await cleanup(request, id);
    }
  });

  test('lists render with markers; cite and figure become chips', async ({ page, request }) => {
    const id = await createProject(request, 'Visual Chips');
    const doc = [
      'Intro text.',
      '\\begin{itemize}',
      '\\item First point',
      '\\item Second point',
      '\\end{itemize}',
      'See \\cite{knuth1984} and Figure ref.',
      '\\begin{figure}',
      '\\caption{A very nice plot}',
      '\\end{figure}',
      'plain end',
      '',
    ].join('\n');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-item')).toHaveCount(2);
      await expect(page.locator('.cm-content')).not.toContainText('\\begin{itemize}');
      await expect(page.getByTestId('vis-chip-cite')).toContainText(/knuth1984|Knuth 1984/);
      await expect(page.getByTestId('vis-chip-figure')).toContainText('A very nice plot');
      await expect(page.locator('.cm-content')).not.toContainText('\\caption');
      // clicking the figure chip reveals its source
      await page.getByTestId('vis-chip-figure').click();
      await expect(page.locator('.cm-content')).toContainText('\\begin{figure}');
    } finally {
      await cleanup(request, id);
    }
  });

  test('Mod-B wraps and unwraps the selection byte-exactly', async ({ page, request }) => {
    const id = await seed(request, 'Visual Bold');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    try {
      await openProject(page, id);
      const line = page.locator('.cm-line', { hasText: 'More prose here.' });
      await line.click();
      // select the word "prose" precisely
      const box = (await line.boundingBox())!;
      await page.mouse.dblclick(box.x + 42, box.y + box.height / 2);
      await page.evaluate(() => window.getSelection()?.toString());
      await page.keyboard.press(`${mod}+b`);
      await page.waitForTimeout(2500); // collab flush
      const wrapped = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(wrapped).toContain('\\textbf{');
      // caret is inside the new bold → construct revealed; toggle again unwraps
      await page.keyboard.press(`${mod}+b`);
      await page.waitForTimeout(2500);
      const unwrapped = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(unwrapped).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });

  test('dual-mode collab: visual and source peers stay byte-consistent', async ({ browser, request }) => {
    const id = await seed(request, 'Dual Mode');
    const mk = async (visual: boolean) => {
      const ctx = await browser.newContext();
      await ctx.addInitScript((v) => {
        window.localStorage.setItem('aldine.onboarded', '1');
        window.localStorage.setItem('aldine.editorMode', v ? 'visual' : 'source');
        window.localStorage.setItem('aldine.name', v ? 'Ada' : 'Grace');
      }, visual);
      return { ctx, page: await ctx.newPage() };
    };
    const A = await mk(true);
    const B = await mk(false);
    try {
      await openProject(A.page, id);
      await openProject(B.page, id);
      await A.page.locator('.cm-line', { hasText: 'More prose here.' }).click();

      // B (source) extends the heading; A (visual) receives the edit. A renders
      // it either as a styled heading or — because B's caret sits in that
      // construct — as revealed raw source (remote-caret force-reveal). Either
      // way the new text must be present in A's document.
      await B.page.locator('.cm-line', { hasText: '\\section{Introduction}' }).click();
      await B.page.keyboard.press('End');
      await B.page.keyboard.press('ArrowLeft'); // inside the closing brace
      await B.page.keyboard.type(' and Basics');
      await expect(A.page.locator('.cm-content')).toContainText('Introduction and Basics', { timeout: 10_000 });

      // remote-caret force-reveal: B's caret sits inside \textbf{...} → A shows raw source
      await B.page.locator('.cm-line', { hasText: '\\textbf{brave}' }).click();
      await B.page.keyboard.press('Home');
      for (let i = 0; i < 15; i++) await B.page.keyboard.press('ArrowRight'); // into "brave"
      // (the remote caret label renders inside the word, so match the markup prefix)
      await expect(A.page.locator('.cm-content')).toContainText('\\textbf{', { timeout: 10_000 });

      // A (visual) types prose; B sees the exact source
      await A.page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await A.page.keyboard.press('End');
      await A.page.keyboard.type(' Extra from A.');
      await expect(B.page.locator('.cm-content')).toContainText('Extra from A.', { timeout: 10_000 });

      // stored bytes match both peers' view of the world, exactly
      await A.page.waitForTimeout(2500);
      const text = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(text).toBe(DOC
        .replace('\\section{Introduction}', '\\section{Introduction and Basics}')
        .replace('More prose here.', 'More prose here. Extra from A.'));
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });

  test('table renders as an editable grid; cell edits are precise', async ({ page, request }) => {
    const id = await createProject(request, 'Visual Table');
    const doc = 'Before.\n\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\nplain end\n';
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc } });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-table')).toBeVisible();
      // edit cell "b" → "beta"
      await page.getByTestId('vis-table').locator('td', { hasText: 'b' }).first().dispatchEvent('mousedown');
      const input = page.getByTestId('vis-table-cell-input');
      await input.fill('beta');
      await input.press('Enter');
      await page.waitForTimeout(2500);
      let text = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(text).toContain('a & beta');
      // add a row
      await page.getByTestId('vis-table-addrow').click();
      await page.waitForTimeout(2500);
      text = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(text.match(/\\\\/g)!.length).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanup(request, id);
    }
  });

  test('outline dropdown lists headings and jumps', async ({ page, request }) => {
    const id = await seed(request, 'Visual Outline');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      const dd = page.getByTestId('outline-dropdown');
      await dd.focus();
      await expect(dd.locator('option', { hasText: 'Introduction' })).toHaveCount(1);
      await expect(dd.locator('option', { hasText: 'Details' })).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a suggestion renders as an inline tracked change and accepts', async ({ page, request }) => {
    const id = await seed(request, 'Visual Suggest');
    try {
      await request.post(`/api/projects/${id}/comments`, {
        data: {
          branch: 'main', file: 'main.tex',
          anchor: { from: DOC.indexOf('More prose here.'), to: DOC.indexOf('More prose here.') + 'More prose'.length, quote: 'More prose' },
          body: 'tighten this', suggestion: 'Less prose', author: 'Reviewer',
        },
      });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'Hello' }).click();
      await expect(page.getByTestId('vis-suggest')).toBeVisible();
      await expect(page.locator('.cm-vis-strike')).toContainText('More prose');
      await page.getByTestId('vis-suggest-accept').click();
      await page.waitForTimeout(2500);
      const text = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(text).toContain('Less prose here.');
    } finally {
      await cleanup(request, id);
    }
  });

  test('pasting rich HTML converts to LaTeX', async ({ page, request }) => {
    const id = await seed(request, 'Visual Paste');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await page.keyboard.press('End');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/html', '<p>Copied <b>bold</b> and <i>slanted</i> words.</p><ul><li>alpha</li><li>beta</li></ul>');
        dt.setData('text/plain', 'Copied bold and slanted words. alpha beta');
        document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(2500);
      const text = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(text).toContain('\\textbf{bold}');
      expect(text).toContain('\\textit{slanted}');
      expect(text).toContain('\\begin{itemize}');
      expect(text).toContain('\\item alpha');
    } finally {
      await cleanup(request, id);
    }
  });

  test('spellcheck toggle no longer remounts the editor', async ({ page, request }) => {
    const id = await seed(request, 'No Remount');
    try {
      await openProject(page, id);
      await page.evaluate(() => { document.querySelector('.cm-content')!.setAttribute('data-mounted', 'once'); });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('spellcheck');
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-content[data-mounted="once"]')).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });
});

// ---------------------------------------------------------------------------
// Visual editor QA fixes: every case asserts the exact stored bytes.
// ---------------------------------------------------------------------------

type Req = Parameters<typeof createProject>[0];
type Browser = import('@playwright/test').Browser;

const stored = async (request: Req, id: string, path = 'main.tex') =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

/** Waits out the collab store debounce. */
async function expectStored(request: Req, id: string, expected: string, path = 'main.tex') {
  await expect.poll(() => stored(request, id, path), { timeout: 20_000 }).toBe(expected);
}

async function seedDoc(request: Req, name: string, content: string) {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
  return id;
}

/** The editor's text without collaborators' caret labels. */
const shownText = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const copy = document.querySelector('.cm-content')!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.cm-ySelectionCaret').forEach((e) => e.remove());
  return copy.textContent ?? '';
});

async function peer(browser: Browser, visual: boolean, name: string) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ v, n }) => {
    window.localStorage.setItem('aldine.onboarded', '1');
    window.localStorage.setItem('aldine.editorMode', v ? 'visual' : 'source');
    window.localStorage.setItem('aldine.name', n);
  }, { v: visual, n: name });
  return { ctx, page: await ctx.newPage() };
}

/** Types into the open formula editor at the end of its formula, then presses Done. */
async function appendInFormula(page: import('@playwright/test').Page, text: string) {
  await expect(page.getByTestId('math-field')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.getByTestId('math-popover-done').click();
  await expect(page.getByTestId('math-popover')).toHaveCount(0);
}

const TABLE_DOC = 'Before.\n\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\nMath $x+y$ here and \\cite{knuth1984} there.\nplain end\n';

test.describe('visual editor: widgets, formulas and keys', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  test('widgets write where they are now after typing above them (VIS-01)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Stale Local', TABLE_DOC);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-table')).toBeVisible();
      await page.locator('.cm-line', { hasText: 'Before.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' More words');
      let expected = TABLE_DOC.replace('Before.', 'Before. More words');
      await expectStored(request, id, expected);

      await page.getByTestId('vis-table').locator('td', { hasText: /^b$/ }).click();
      await page.getByTestId('vis-table-cell-input').fill('beta');
      await page.getByTestId('vis-table-cell-input').press('Enter');
      expected = expected.replace('a & b \\\\', 'a & beta \\\\');
      await expectStored(request, id, expected);

      await page.getByTestId('vis-table-addrow').click();
      expected = expected.replace('c & d \\\\\n', 'c & d \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);

      await page.getByTestId('vis-math').click();
      await appendInFormula(page, '+1');
      expected = expected.replace('$x+y$', '$x+y+1$');
      await expectStored(request, id, expected);

      await page.getByTestId('vis-chip-cite').click();
      await page.keyboard.type('Z');
      expected = expected.replace('\\cite{', '\\Zcite{');
      await expectStored(request, id, expected);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a collaborator typing above an open widget moves it, nothing is lost (VIS-01)', async ({ browser, request }) => {
    const id = await seedDoc(request, 'Visual Stale Remote', TABLE_DOC);
    const A = await peer(browser, true, 'Ada');
    const B = await peer(browser, false, 'Grace');
    try {
      await openProject(A.page, id);
      await openProject(B.page, id);
      await A.page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(A.page.getByTestId('vis-table')).toBeVisible();
      const typeAbove = async (text: string) => {
        await B.page.locator('.cm-line', { hasText: 'Before.' }).click();
        await B.page.keyboard.press('Home');
        await B.page.keyboard.type(text);
      };

      await typeAbove('XXXX ');
      await expect.poll(() => shownText(A.page)).toContain('XXXX Before.');
      await A.page.getByTestId('vis-table').locator('td', { hasText: /^b$/ }).click();
      // the collaborator types again while the cell editor is open
      await typeAbove('YY ');
      await expect.poll(() => shownText(A.page)).toContain('YY XXXX Before.');
      await A.page.getByTestId('vis-table-cell-input').fill('beta');
      await A.page.getByTestId('vis-table-cell-input').press('Enter');
      let expected = TABLE_DOC.replace('Before.', 'YY XXXX Before.').replace('a & b \\\\', 'a & beta \\\\');
      await expectStored(request, id, expected);

      // the formula editor stays open across a collaborator's edit above it
      await A.page.getByTestId('vis-math').click();
      await expect(A.page.getByTestId('math-field')).toBeFocused();
      await typeAbove('ZZ ');
      await expect.poll(() => shownText(A.page)).toContain('ZZ YY XXXX Before.');
      await A.page.getByTestId('math-field').click();
      await appendInFormula(A.page, '-1');
      expected = expected.replace('YY XXXX', 'ZZ YY XXXX').replace('$x+y$', '$x+y-1$');
      await expectStored(request, id, expected);
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });

  test('two people editing cells of one table keep each other\'s edits and the open editor (VIS-01)', async ({ browser, request }) => {
    const id = await seedDoc(request, 'Visual Two Cells', TABLE_DOC);
    const A = await peer(browser, true, 'Ada');
    const B = await peer(browser, true, 'Grace');
    try {
      for (const p of [A, B]) {
        await openProject(p.page, id);
        await p.page.locator('.cm-line', { hasText: 'plain end' }).click();
        await expect(p.page.getByTestId('vis-table')).toBeVisible();
      }
      await A.page.getByTestId('vis-table').locator('td', { hasText: /^b$/ }).click();
      await A.page.keyboard.type('be');
      await B.page.getByTestId('vis-table').locator('td', { hasText: /^d$/ }).click();
      await B.page.keyboard.type('delta');
      await B.page.keyboard.press('Enter');
      await expect(A.page.getByTestId('vis-table').locator('td', { hasText: /^delta$/ })).toHaveCount(1);
      // A's editor moved into the redrawn grid with its text
      await expect(A.page.getByTestId('vis-table-cell-input')).toHaveValue('be');
      await expect(A.page.getByTestId('vis-table-cell-input')).toBeFocused();
      await A.page.keyboard.type('ta');
      await A.page.keyboard.press('Enter');
      await expectStored(request, id, TABLE_DOC.replace('a & b \\\\', 'a & beta \\\\').replace('c & d \\\\', 'c & delta \\\\'));
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });

  test('the formula editor changes only what was typed, and leaves what it would rewrite to source (VIS-02, VIS-04)', async ({ page, request }) => {
    const doc = [
      'Sum: $ a + b $ end.',
      '\\begin{equation}\\label{eq:one}',
      '  f(x) = \\frac{1}{2}x % keep me',
      '\\end{equation}',
      '\\begin{align}',
      '  a &= b \\\\',
      '  c &= d',
      '\\end{align}',
      'Script $x_{i}^{2}$ and $\\frac{1}{2}x$.',
      '$$ E = mc^2 $$',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual MathLive', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const math = page.getByTestId('vis-math');
      await expect(math).toHaveCount(6);
      // $$…$$ is typeset, not shown as an error
      await expect(math.nth(5).locator('.katex')).toBeVisible();
      await expect(math.nth(5)).not.toHaveClass(/cm-vis-math--raw/);

      await math.nth(0).click();
      await appendInFormula(page, '+1');
      let expected = doc.replace('$ a + b $', '$ a + b+1 $');
      await expectStored(request, id, expected);

      // a labelled, commented equation and an align block open as source, never in MathLive
      for (const [n, marker] of [[1, '\\label{eq:one}'], [2, 'a &= b']] as const) {
        await page.locator('.cm-line', { hasText: 'plain end' }).click();
        await page.getByTestId('vis-math').nth(n).click();
        await expect(page.locator('.cm-content')).toContainText(marker);
        await expect(page.getByTestId('math-popover')).toHaveCount(0);
      }

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(3).click();
      await appendInFormula(page, '+1');
      expected = expected.replace('$x_{i}^{2}$', '$x_{i}^{2}+1$');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(4).click();
      await appendInFormula(page, '+1');
      expected = expected.replace('$\\frac{1}{2}x$', '$\\frac{1}{2}x+1$');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(5).click();
      await appendInFormula(page, '+1');
      expected = expected.replace('$$ E = mc^2 $$', () => '$$ E = mc^2+1 $$');
      await expectStored(request, id, expected);

      // opening and closing without a change writes nothing
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(0).click();
      await page.getByTestId('math-popover-done').click();
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(expected);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a cell editor commits once, cancels on Escape and hands focus back (VIS-05)', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const id = await seedDoc(request, 'Visual Cell Keys', TABLE_DOC);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.keyboard.press('End');
      const cell = (t: RegExp) => page.getByTestId('vis-table').locator('td', { hasText: t });
      const input = page.getByTestId('vis-table-cell-input');

      await cell(/^b$/).click();
      await input.fill('zzz');
      await input.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(TABLE_DOC);

      await cell(/^b$/).click();
      await input.fill('beta');
      await input.press('Enter');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.type('!');
      let expected = TABLE_DOC.replace('a & b \\\\', 'a & beta \\\\').replace('plain end', 'plain end!');
      await expectStored(request, id, expected);

      // Tab commits and moves to the next cell's editor
      await cell(/^c$/).click();
      await input.fill('gamma');
      await input.press('Tab');
      await expect(input).toHaveValue('d');
      await input.fill('delta');
      await input.press('Escape');
      expected = expected.replace('c & d \\\\', 'gamma & d \\\\');
      await expectStored(request, id, expected);
      expect(errors).toEqual([]);
    } finally {
      await cleanup(request, id);
    }
  });

  test('comment rows stay out of the grid and + col extends spec and rows (VIS-06)', async ({ page, request }) => {
    const doc = [
      '\\begin{tabular}{|l|c|}',
      '\\hline',
      'a & b \\& c \\\\[2pt]',
      '% commented row & z \\\\',
      '1 & 2 \\\\',
      '\\hline',
      '\\end{tabular}',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Table Shapes', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      await expect(grid.locator('tr')).toHaveCount(2);
      await expect(grid).not.toContainText('commented');
      await expect(grid).not.toContainText('[2pt]');
      await expect(grid.locator('td', { hasText: /^1$/ })).toHaveCount(1);
      await page.getByTestId('vis-table-addcol').click();
      await expectStored(request, id, doc
        .replace('{|l|c|}', '{|l|c|l|}')
        .replace('b \\& c \\\\[2pt]', 'b \\& c &  \\\\[2pt]')
        .replace('1 & 2 \\\\', '1 & 2 &  \\\\'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('End on the last item or a heading types inside it (VIS-07)', async ({ page, request }) => {
    const doc = '\\begin{itemize}\n\\item First\n\\item Second\n\\end{itemize}\n\\section{Heading}\n\\paragraph{Para} run-in text\nplain end\n';
    const id = await seedDoc(request, 'Visual Line Ends', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.locator('.cm-content')).not.toContainText('\\end{itemize}');
      await page.locator('.cm-line', { hasText: 'Second' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' more');
      let expected = doc.replace('\\item Second\n', '\\item Second more\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.locator('.cm-vis-h1').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' two');
      expected = expected.replace('\\section{Heading}', '\\section{Heading two}');
      await expectStored(request, id, expected);

      // a run-in heading styles its argument, not the body text after it
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.locator('.cm-vis-hrun')).toHaveText('Para');
      await expect(page.locator('.cm-vis-h', { hasText: 'run-in text' })).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a heading with its \\label or a comment on the same line renders as a heading (VIS-07)', async ({ page, request }) => {
    const doc = [
      '\\section{Own line}',
      'Body one.',
      '\\section{Introduction}\\label{sec:intro}',
      'Body two.',
      '\\subsection{Setup} \\label{sec:setup}',
      'Body three.',
      '\\section{Commented}\\label{sec:c} % note',
      'Body four.',
      '\\paragraph{Run-in} body text on the same line.',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Heading Label', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const h1 = page.locator('.cm-line.cm-vis-h1');
      await expect(h1).toHaveCount(3);
      await expect(h1.nth(1)).toContainText('Introduction');
      await expect(h1.nth(2)).toContainText('Commented');
      await expect(page.locator('.cm-line.cm-vis-h2')).toContainText('Setup');
      const size = (text: string) => page.locator('.cm-line', { hasText: text }).first().evaluate((l) => parseFloat(getComputedStyle(l).fontSize));
      expect(await size('Introduction')).toBeGreaterThan(await size('Body two.'));
      expect(await size('Setup')).toBeGreaterThan(await size('Body three.'));
      await expect(page.locator('.cm-vis-hrun')).toHaveText(['Run-in']);
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Enter at the end of a heading starts the next paragraph after it, in Visual only (VIS-07)', async ({ page, request }) => {
    const doc = 'Intro.\n\\section{Heading}\nBody text.\n\\section{Introduction}\\label{sec:intro}\nMore.\nMethods\nplain end\n';
    const id = await seedDoc(request, 'Visual Heading Enter', doc);
    const clickPastText = async (text: string) => {
      const box = (await page.locator('.cm-line.cm-vis-h1', { hasText: text }).boundingBox())!;
      await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
    };
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();

      await clickPastText('Heading');
      await page.keyboard.press('Enter');
      await page.keyboard.type('New para');
      let expected = doc.replace('\\section{Heading}\n', '\\section{Heading}\nNew para\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.locator('.cm-line.cm-vis-h1', { hasText: 'Heading' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('First para');
      expected = expected.replace('\\section{Heading}\n', '\\section{Heading}\nFirst para\n');
      await expectStored(request, id, expected);

      // a same-line \label stays with the heading
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await clickPastText('Introduction');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Labelled para');
      expected = expected.replace('\\label{sec:intro}\n', '\\label{sec:intro}\nLabelled para\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'Methods' }).click();
      await page.keyboard.press('End');
      await page.getByTestId('format-toolbar').getByLabel('Heading level').selectOption('1');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.press('Enter');
      await page.keyboard.type('We did things.');
      expected = expected.replace('Methods\n', '\\section{Methods}\nWe did things.\n');
      await expectStored(request, id, expected);

      // Source keeps plain Enter: the caret before the brace splits the argument
      await page.getByTestId('mode-source').click();
      await page.locator('.cm-line', { hasText: '\\section{Methods}' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/\\section\{Methods\n[ \t]*\}\nWe did things\.\n/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('cite chips show page and prenote (VIS-08)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Cite Notes', 'See \\cite[p.~12]{knuth1984} and \\cite[see][ch.~3]{lamport1994}.\nplain end\n');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const chips = page.getByTestId('vis-chip-cite');
      await expect(chips.nth(0)).toContainText(/(knuth1984|Knuth 1984), p\. 12/);
      await expect(chips.nth(1)).toContainText(/see (lamport1994|Lamport 1994), ch\. 3/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('inline suggestions survive Source → Visual (VIS-09)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Suggest Toggle', DOC);
    try {
      await request.post(`/api/projects/${id}/comments`, {
        data: {
          branch: 'main', file: 'main.tex',
          anchor: { from: DOC.indexOf('More prose here.'), to: DOC.indexOf('More prose here.') + 'More prose'.length, quote: 'More prose' },
          body: 'tighten this', suggestion: 'Less prose', author: 'Reviewer',
        },
      });
      await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'source'));
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('More prose');
      await page.getByTestId('mode-visual').click();
      await page.locator('.cm-line', { hasText: 'Hello' }).click();
      await expect(page.getByTestId('vis-suggest')).toBeVisible();
      await page.getByTestId('mode-source').click();
      await page.getByTestId('mode-visual').click();
      await expect(page.getByTestId('vis-suggest')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('a Google Docs paste keeps its bold and italic runs and never wraps paragraphs; anchor links keep their text (VIS-10)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Paste Docs', DOC);
    const paste = (html: string, text: string) => page.evaluate(({ html, text }) => {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', text);
      document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { html, text });
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await paste(
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr"><span style="font-weight:700;">Bold run</span><span style="font-weight:400;"> then plain.</span></p><br><p dir="ltr"><span style="font-style:italic;font-weight:400;">Italic paragraph.</span></p></b>',
        'Bold run then plain.\n\nItalic paragraph.',
      );
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\textbf{Bold run} then plain.\n\n\\textit{Italic paragraph.}');
      const text = await stored(request, id);
      expect(text).not.toMatch(/\\textbf\{[^}]*\n\n/);
      await page.keyboard.press('Enter');
      await paste('<p>See <a href="#results">the results section</a> for details.</p>', 'See the results section for details.');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('See the results section for details.');
      expect(await stored(request, id)).not.toContain('\\url{#');
    } finally {
      await cleanup(request, id);
    }
  });

  test('a .bib opens as source with no format toolbar, and Visual comes back for .tex (VIS-11)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Bib', DOC);
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: '@article{k,\n  title = {On \\textbf{Bold} $x$ Things},\n}\n' } });
      await openProject(page, id);
      await expect(page.getByTestId('format-toolbar')).toBeVisible();
      await page.getByTestId('file-refs.bib').click();
      await expect(page.getByTestId('active-file')).toHaveText('refs.bib');
      await expect(page.locator('.cm-content')).toContainText('\\textbf{Bold} $x$');
      await expect(page.getByTestId('format-toolbar')).toHaveCount(0);
      await expect(page.getByTestId('mode-toggle')).toHaveCount(0);
      await expect(page.getByTestId('vis-math')).toHaveCount(0);
      await page.getByTestId('file-main.tex').click();
      await expect(page.getByTestId('format-toolbar')).toBeVisible();
      await expect(page.getByTestId('mode-visual')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await cleanup(request, id);
    }
  });

  test('typing \\begin{itemize} closes it once (VIS-12)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Begin', DOC);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'More prose here.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\begin{itemize}', { delay: 30 });
      await page.keyboard.type('\\item x');
      // (Enter indents the new line inside the subsection; the environment keeps that indentation)
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/More prose here\.\n( *)\\begin\{itemize\}\n\1  \\item x\n\1\\end\{itemize\}\n$/);
    } finally {
      await cleanup(request, id);
    }
  });

  test('constructs far down a long file render without an edit (VIS-14)', async ({ page, request }) => {
    const filler = Array.from({ length: 6000 }, (_, i) => `Line ${i} of plain prose that fills the document.`).join('\n');
    const id = await seedDoc(request, 'Visual Long', `\\section{Top}\n${filler}\n\\section{Far away}\nTail $z^2$ and \\textbf{bold}.\nplain end\n`);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'Line 3 of' }).click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await expect(page.locator('.cm-vis-h1', { hasText: 'Far away' })).toBeVisible();
      await expect(page.locator('.cm-vis-b', { hasText: 'bold' })).toBeVisible();
      await expect(page.getByTestId('vis-math')).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('figure previews resolve extension-less and PDF graphics without 404s; a subfigure keeps the main caption (VIS-16)', async ({ page, request }) => {
    const notFound: string[] = [];
    page.on('response', (r) => { if (r.status() === 404 && r.url().includes('/file?')) notFound.push(r.url()); });
    const doc = [
      '\\begin{figure}', '\\includegraphics[width=0.6\\linewidth]{plot}', '\\caption{A plot}', '\\end{figure}',
      '\\begin{figure}', '\\includegraphics{vector.pdf}', '\\caption{A vector}', '\\end{figure}',
      '\\begin{figure}', '\\begin{subfigure}{0.4\\linewidth}\\caption{Left}\\end{subfigure}', '\\caption{Two panels}', '\\end{figure}',
      'plain end', '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Figures', doc);
    try {
      await openProject(page, id);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 50]/Contents 4 0 R>>endobj\n4 0 obj<</Length 25>>stream\n0 0 1 rg 10 10 80 30 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
      await page.getByTestId('upload-input').setInputFiles([
        { name: 'plot.png', mimeType: 'image/png', buffer: png },
        { name: 'vector.pdf', mimeType: 'application/pdf', buffer: pdf },
      ]);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const figures = page.getByTestId('vis-chip-figure');
      await expect(figures.nth(0).getByTestId('vis-figure-img')).toHaveJSProperty('complete', true);
      // the caption beside the preview is its text alternative
      await expect(figures.nth(0).getByTestId('vis-figure-img')).toHaveAttribute('alt', '');
      await expect.poll(() => figures.nth(0).getByTestId('vis-figure-img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await expect(figures.nth(1).getByTestId('vis-figure-img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 15_000 });
      await expect(figures.nth(2)).toContainText('Figure: Two panels');
      expect(notFound).toEqual([]);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the formula editor is a keyboard dialog (VIS-17)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Math Keys', 'Math $x+y$ here.\nplain end\n');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').click();
      const pop = page.getByTestId('math-popover');
      await expect(pop).toHaveAttribute('role', 'dialog');
      await expect(pop).toHaveAttribute('aria-modal', 'true');
      await expect(page.getByTestId('math-popover-source')).toHaveText('Edit source');
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('math-popover-done')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('math-popover-source')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await expect(page.locator('.cm-content')).toBeFocused();

      // with the caret in a formula's source, Mod-Enter opens the editor on it
      await page.locator('.cm-line', { hasText: 'Math' }).click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);

      // the same from the command palette, which names the key; hovering the formula says it too
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-math')).toHaveAttribute('title', /^Edit formula \((⌘|Ctrl\+)Enter in its source\)$/);
      await page.locator('.cm-line', { hasText: 'Math' }).click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('formula or table');
      await expect(page.getByTestId('palette-item-edit-at-cursor')).toContainText(/(⌘|Ctrl\+)Enter/);
      await page.getByTestId('palette-item-edit-at-cursor').click();
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe('Math $x+y$ here.\nplain end\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('keys typed while the formula editor loads go into the formula, never into the text', async ({ page, request }) => {
    const doc = '\\section{Introduction}\nThe cost is $x^2$ per step.\nplain end\n';
    const id = await seedDoc(request, 'Visual Math Loading', doc);
    // MathLive arrives only when the test lets it, as on a slow connection
    let arrive = () => {};
    let held = new Promise<void>((r) => { arrive = r; });
    await page.route(/\/assets\/mathlive[^/]*\.js/, async (route) => { await held; await route.continue(); });
    const pop = page.getByTestId('math-popover');
    const field = page.getByTestId('math-field');
    const mathliveIn = () => page.waitForFunction(() => !!customElements.get('math-field'));
    try {
      await openProject(page, id);
      // the caret in the heading, which shows its source
      await page.locator('.cm-line', { hasText: 'Introduction' }).click();
      await expect(page.locator('.cm-content')).toContainText('\\section{Introduction}');
      await page.getByTestId('vis-math').click();
      await page.keyboard.type('+1');
      arrive();
      await expect(field).toBeFocused();
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);
      await expect.poll(() => field.evaluate((mf) => (mf as HTMLElement & { value: string }).value)).toBe('x^2+1');
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);

      // Escape, a click elsewhere or the command palette while it loads: the
      // formula editor never opens, and the next keys go where they are typed
      held = new Promise<void>((r) => { arrive = r; });
      await page.reload();
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.keyboard.press('End');
      await page.getByTestId('vis-math').click();
      await page.keyboard.type('Q');
      await page.keyboard.press('Escape');
      await page.keyboard.type('!');
      await page.getByTestId('vis-math').click();
      await page.keyboard.type('W');
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type('?');
      await page.getByTestId('vis-math').click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await expect(page.getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('formula');
      await expect(page.getByTestId('palette-input')).toHaveValue('formula');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('palette-input')).toHaveCount(0);
      arrive();
      await mathliveIn();
      await page.waitForTimeout(500);
      await expect(pop).toHaveCount(0);
      await expectStored(request, id, doc.replace('plain end', 'plain end!?'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('a search result opens selected, its construct shown as source, and changes no byte', async ({ page, request }) => {
    const main = '\\section{Introduction}\nHello \\textbf{brave} new \\emph{world} of text.\nThe cost is $x^2$ per step, see \\cite{knuth1984}.\n\\begin{itemize}\n\\item first point\n\\end{itemize}\nplain end\n';
    const other = 'Chapter text with $y_1$ inside.\n';
    const id = await seedDoc(request, 'Visual Search', main);
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'other.tex', content: other } });
    const content = page.locator('.cm-content');
    const selected = () => page.evaluate(() => window.getSelection()?.toString());
    const open = async (query: string, path = 'main.tex') => {
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill(query);
      const match = page.locator(`[data-testid="search-match"][data-path="${path}"]`).first();
      // the results of this query, not the last one's
      await expect(match.locator('mark')).toHaveText(query);
      await match.click();
      await expect(page.getByTestId('active-file')).toHaveText(path);
      await expect.poll(selected).toBe(query);
      await expect(content).toBeFocused();
    };
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.locator('.cm-vis-b')).toContainText('brave');

      await open('brave');
      await expect(content).toContainText('\\textbf{brave}');
      await expect(page.locator('.cm-vis-i')).toContainText('world');
      await open('x^2');
      await expect(content).toContainText('$x^2$ per step');
      await expect(content).not.toContainText('\\textbf{');
      await open('knuth1984');
      await expect(content).toContainText('\\cite{knuth1984}');
      await open('itemize');
      await expect(content).toContainText('\\begin{itemize}');
      await open('Introduction');
      await expect(content).toContainText('\\section{Introduction}');
      // another file opens in Visual too, the match selected once it has loaded
      await open('y_1', 'other.tex');
      await expect(page.getByTestId('mode-visual')).toHaveAttribute('aria-pressed', 'true');
      await expect(content).toContainText('$y_1$ inside');

      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(main);
      expect(await stored(request, id, 'other.tex')).toBe(other);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the table grid works from the keyboard (VIS-18)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Table Keys', TABLE_DOC);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-table-addrow').focus();
      await page.keyboard.press('Enter');
      let expected = TABLE_DOC.replace('c & d \\\\\n', 'c & d \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);
      await page.getByTestId('vis-table-addcol').focus();
      await page.keyboard.press('Space');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\begin{tabular}{lll}');
      expected = await stored(request, id);
      expect(expected).toContain('a & b &  \\\\\nc & d &  \\\\\n&   & \\\\\n\\end{tabular}');

      // a focused cell opens on Enter; Mod-Enter in the table's source jumps into the grid
      await page.getByTestId('vis-table').locator('td').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('vis-table-cell-input')).toHaveValue('a');
      await page.keyboard.press('Escape');
      await page.locator('.cm-line', { hasText: 'Before.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowRight'); // into the table's source: it shows as text
      await expect(page.locator('.cm-content')).toContainText('\\begin{tabular}');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await expect(page.getByTestId('vis-table').locator('td').first()).toBeFocused();
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(expected);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Enter on a focused accept button accepts and types nothing (VIS-19)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Suggest Keys', DOC);
    try {
      await request.post(`/api/projects/${id}/comments`, {
        data: {
          branch: 'main', file: 'main.tex',
          anchor: { from: DOC.indexOf('More prose here.'), to: DOC.indexOf('More prose here.') + 'More prose'.length, quote: 'More prose' },
          body: 'tighten this', suggestion: 'Less prose', author: 'Reviewer',
        },
      });
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'Hello' }).click();
      const accept = page.getByTestId('vis-suggest-accept');
      await expect(accept).toHaveAttribute('aria-label', 'Accept suggestion: Less prose');
      await accept.focus();
      await page.keyboard.press('Enter');
      await expectStored(request, id, DOC.replace('More prose here.', 'Less prose here.'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('screen readers get the math, the chip kinds and the editor\'s name (VIS-20)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual A11y', 'A fraction $\\frac{1}{2}$ and \\cite{k}.\nplain end\n');
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-math').locator('math')).toHaveCount(1);
      await expect(page.getByTestId('vis-chip-cite').locator('.cm-vis-sr')).toHaveText(/^Citation:\s*$/);
      await expect(page.locator('.cm-content')).toHaveAttribute('aria-label', 'Text of main.tex');
    } finally {
      await cleanup(request, id);
    }
  });

  test('CRLF files take edits where they are typed, in both modes (VIS-03)', async ({ browser, request }) => {
    const crlf = '\\section{One}\r\nline two\r\nline three\r\nline four\r\nplain end\r\n';
    const id = await seedDoc(request, 'Visual CRLF', crlf);
    const A = await peer(browser, true, 'Ada');
    const B = await peer(browser, false, 'Grace');
    try {
      await openProject(A.page, id);
      await A.page.locator('.cm-line', { hasText: 'line four' }).click();
      await A.page.keyboard.press('End');
      await A.page.keyboard.type('XYZ');
      // the file keeps its CRLF line endings
      await expectStored(request, id, crlf.replace('line four', 'line fourXYZ'));
      await openProject(B.page, id);
      await expect(B.page.locator('.cm-content')).toContainText('line fourXYZ');
      await B.page.locator('.cm-line', { hasText: 'line two' }).click();
      await B.page.keyboard.press('End');
      await B.page.keyboard.type('!');
      await expectStored(request, id, crlf.replace('line four', 'line fourXYZ').replace('line two', 'line two!'));
      await expect(A.page.locator('.cm-content')).toContainText('line two!');
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });
});

test.describe('visual editor: wrapped cells, new rows, collaborators in a table, formulas on their own lines', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  test('a cell written over two lines opens in the source, and passing through cells writes nothing', async ({ page, request }) => {
    const doc = '\\begin{tabular}{ll}\nLong text the author\nwrapped & b \\\\\nc & d \\\\\n\\end{tabular}\nplain end\n';
    const id = await seedDoc(request, 'Visual Wrapped Cell', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      const wrapped = grid.locator('td').first();
      await expect(wrapped).toHaveText('Long text the author wrapped');
      await expect(wrapped).toHaveAttribute('title', /^Edit in the source \(Enter\)/);
      // Shift+Tab out of the next cell lands on it without opening it
      await grid.locator('td', { hasText: /^b$/ }).click();
      await page.keyboard.press('Shift+Tab');
      await expect(wrapped).toBeFocused();
      await expect(page.getByTestId('vis-table-cell-input')).toHaveCount(0);
      // opening and leaving plain cells, by Tab, Enter and a click elsewhere, writes nothing
      await grid.locator('td', { hasText: /^c$/ }).click();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('vis-table-cell-input')).toHaveValue('d');
      await page.keyboard.press('Enter');
      await grid.locator('td', { hasText: /^b$/ }).click();
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      // a click on the wrapped cell goes to its source
      await wrapped.click();
      await expect(page.locator('.cm-content')).toContainText('\\begin{tabular}{ll}');
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);
    } finally {
      await cleanup(request, id);
    }
  });

  test('"+ row" adds the row after the last one when that has no \\\\ and when the table sits on one line', async ({ page, request }) => {
    const doc = 'Top.\n\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}\nName: \\begin{tabular}{@{}l@{}}first\\\\second\\end{tabular} done\nplain end\n';
    const id = await seedDoc(request, 'Visual Add Row', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grids = page.getByTestId('vis-table');
      await expect(grids).toHaveCount(2);
      await grids.nth(0).getByTestId('vis-table-addrow').click();
      let expected = doc.replace('c & d\n', 'c & d \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);
      await expect(grids.nth(0).locator('tr')).toHaveCount(3);
      await grids.nth(1).getByTestId('vis-table-addrow').click();
      expected = expected.replace('first\\\\second\\end', 'first\\\\second \\\\ \\\\\\end');
      await expectStored(request, id, expected);
      await expect(grids.nth(1).locator('tr')).toHaveCount(3);
    } finally {
      await cleanup(request, id);
    }
  });

  test('"+ col" without a column spec stays in the Tab order and says why it does nothing', async ({ page, request }) => {
    const doc = '\\begin{tabular}\na & b \\\\\n\\end{tabular}\nplain end\n';
    const id = await seedDoc(request, 'Visual No Spec', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      await expect(grid.locator('td').first()).toHaveAttribute('title', 'Edit cell (Enter)');
      const addcol = page.getByTestId('vis-table-addcol');
      await expect(addcol).toHaveAttribute('aria-disabled', 'true');
      await expect(grid).toContainText('No column spec found: add columns in the source');
      await addcol.focus();
      await expect(addcol).toBeFocused();
      await page.keyboard.press('Enter');
      await addcol.click({ force: true });
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);
    } finally {
      await cleanup(request, id);
    }
  });

  test('an open cell stays its cell when a collaborator adds a row above it, and asks before replacing their change', async ({ browser, request }) => {
    const id = await seedDoc(request, 'Visual Cell Rows', TABLE_DOC);
    const A = await peer(browser, true, 'Ada');
    const B = await peer(browser, true, 'Grace');
    try {
      for (const p of [A, B]) {
        await openProject(p.page, id);
        await p.page.locator('.cm-line', { hasText: 'plain end' }).click();
        await expect(p.page.getByTestId('vis-table')).toBeVisible();
      }
      const grid = A.page.getByTestId('vis-table');
      const input = A.page.getByTestId('vis-table-cell-input');
      await grid.locator('td', { hasText: /^c$/ }).click();
      await A.page.keyboard.type('gam');
      // a row break typed into a cell above: the open cell moves down a row
      await B.page.getByTestId('vis-table').locator('td', { hasText: /^b$/ }).click();
      await B.page.keyboard.type('b \\\\ x & y');
      await B.page.keyboard.press('Enter');
      await expect(grid.locator('tr')).toHaveCount(3);
      await expect(input).toHaveValue('gam');
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('aria-label', 'Row 3, column 1');
      await A.page.keyboard.type('ma');
      await A.page.keyboard.press('Enter');
      let expected = TABLE_DOC.replace('a & b \\\\\n', 'a & b \\\\ x & y \\\\\n').replace('c & d', 'gamma & d');
      await expectStored(request, id, expected);

      // the collaborator changes the very cell: told first, Enter then replaces it
      await grid.locator('td', { hasText: /^d$/ }).click();
      await A.page.keyboard.type('del');
      await B.page.getByTestId('vis-table').locator('td', { hasText: /^d$/ }).click();
      await B.page.keyboard.type('D');
      await B.page.keyboard.press('Enter');
      await expect(A.page.getByTestId('vis-table-notice')).toContainText('Someone else changed this cell');
      await expect(input).toHaveValue('del');
      await expect(input).toBeFocused();
      await A.page.keyboard.type('ta');
      await A.page.keyboard.press('Enter');
      expected = expected.replace('gamma & d', 'gamma & delta');
      await expectStored(request, id, expected);
    } finally {
      await A.ctx.close();
      await B.ctx.close();
      await cleanup(request, id);
    }
  });

  test('a formula on lines of its own opens in the formula editor, and spaces typed in \\text are written', async ({ page, request }) => {
    const doc = 'Text.\n\\begin{equation}\n  E = mc^2\n\\end{equation}\n\\[\n  a + b\n\\]\nWords $x \\text{ab} y$ more.\nCases $p \\text{ if } q$ too.\nplain end\n';
    const id = await seedDoc(request, 'Visual Formula Lines', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const math = page.getByTestId('vis-math');
      await expect(math).toHaveCount(4);
      await math.nth(0).click();
      await appendInFormula(page, '+1');
      let expected = doc.replace('E = mc^2\n', 'E = mc^2+1\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(1).click();
      await appendInFormula(page, '-c');
      expected = expected.replace('a + b\n', 'a + b-c\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(2).click();
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.getByTestId('math-field').evaluate((mf) => { (mf as HTMLElement & { value: string }).value = 'x \\text{a b} y'; });
      await page.getByTestId('math-popover-done').click();
      await expect(page.getByTestId('math-popover')).toHaveCount(0);
      expected = expected.replace('\\text{ab}', '\\text{a b}');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(3).click();
      await expect(page.getByTestId('math-field')).toBeFocused();
      await page.getByTestId('math-field').evaluate((mf) => { (mf as HTMLElement & { value: string }).value = 'p \\text{ if and only if } q'; });
      await page.getByTestId('math-popover-done').click();
      await expect(page.getByTestId('math-popover')).toHaveCount(0);
      expected = expected.replace('\\text{ if }', '\\text{ if and only if }');
      await expectStored(request, id, expected);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('visual editor: pastes, escapes, keys and formulas', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  const pasteAtEnd = (page: import('@playwright/test').Page, data: Record<string, string>) => page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);

  test('a paste in Visual always typesets: links need \\url to be loaded, plain text is escaped (#149)', async ({ page, request }) => {
    const article = (pre: string) => `\\documentclass{article}\n${pre}\\begin{document}\nprose here\n\\end{document}\n`;
    const link = { 'text/html': '<p>See <a href="https://example.org/a_b">the site</a>.</p>', 'text/plain': 'See the site.' };
    const bare = await seedDoc(request, 'Visual Paste Bare', article(''));
    const linked = await seedDoc(request, 'Visual Paste Url', article('\\usepackage{hyperref}\n'));
    try {
      await openProject(page, bare);
      await page.locator('.cm-line', { hasText: 'prose here' }).click();
      await page.keyboard.press('End');
      await pasteAtEnd(page, link);
      await expectStored(request, bare, article('').replace('prose here', 'prose hereSee the site (https://example.org/a\\_b).'));
      await pasteAtEnd(page, { 'text/plain': ' 50% & $5 #3' });
      await expectStored(request, bare, article('').replace('prose here', 'prose hereSee the site (https://example.org/a\\_b). 50\\% \\& \\$5 \\#3'));
      await openProject(page, linked);
      await page.locator('.cm-line', { hasText: 'prose here' }).click();
      await page.keyboard.press('End');
      await pasteAtEnd(page, link);
      await expectStored(request, linked, article('\\usepackage{hyperref}\n').replace('prose here', 'prose hereSee the site (\\url{https://example.org/a_b}).'));
    } finally {
      await cleanup(request, bare);
      await cleanup(request, linked);
    }
  });

  test('escapes, \\ldots and \\url render as what they typeset, \\centering and a heading\'s \\label hide, and no byte changes (#150)', async ({ page, request }) => {
    const doc = [
      '\\section{Costs} \\label{sec:costs}',
      'Save 50\\% \\& \\$5 on \\#3 a\\_b, \\textasciitilde{} and more\\ldots{} at \\url{https://example.org/x}.',
      '\\begin{table}',
      '\\centering',
      '\\begin{tabular}{ll}',
      'a & b \\\\',
      '\\end{tabular}',
      '\\end{table}',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Escapes', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await expect(page.getByTestId('vis-table')).toBeVisible();
      const text = await shownText(page);
      expect(text).toContain('Save 50% & $5 on #3 a_b, ~ and more… at https://example.org/x.');
      expect(text).not.toContain('\\centering');
      expect(text).not.toContain('\\label');
      await expect(page.locator('.cm-vis-url')).toHaveText('https://example.org/x');
      // a tour across the escapes, the link and the heading writes nothing
      await page.locator('.cm-line', { hasText: 'Save 50' }).click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 90; i++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End');
      await page.locator('.cm-line.cm-vis-h1').click();
      await expect(page.locator('.cm-content')).toContainText('\\label{sec:costs}');
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);
      // End in the heading stops before the brace its label hides with
      await page.keyboard.press('End');
      await page.keyboard.type(' now');
      await expectStored(request, id, doc.replace('{Costs}', '{Costs now}'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('Enter and Backspace around lists, Enter in body text and a heading on an empty line (#151)', async ({ page, request }) => {
    const doc = '\\section{List}\nBody text.\n\\begin{itemize}\n\\item One\n\\item Two\n\\end{itemize}\nAfter list.\nplain end\n';
    const id = await seedDoc(request, 'Visual List Keys', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      // Enter at the end of the last item starts a new one; Enter on the empty one leaves the list
      await page.locator('.cm-line', { hasText: 'Two' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Three');
      let expected = doc.replace('\\item Two\n', '\\item Two\n\\item Three\n');
      await expectStored(request, id, expected);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Para');
      expected = expected.replace('\\end{itemize}\n', '\\end{itemize}\nPara\n');
      await expectStored(request, id, expected);
      // Backspace at the start of the line after the list goes into it, deleting nothing
      await page.keyboard.press('Home');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('!');
      expected = expected.replace('\\item Three\n', '\\item Three!\n');
      await expectStored(request, id, expected);
      await expect(page.locator('.cm-content')).not.toContainText('\\end{itemize}');
      // a new line under body text in a section is not indented
      await page.locator('.cm-line', { hasText: 'Body text.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('More');
      expected = expected.replace('Body text.\n', 'Body text.\nMore\n');
      await expectStored(request, id, expected);
      // Heading level on an empty line writes an empty heading to type into
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.getByTestId('format-toolbar').getByLabel('Heading level').selectOption('1');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.type('New');
      expected = expected.replace('plain end\n', 'plain end\n\\section{New}\n');
      await expectStored(request, id, expected);
    } finally {
      await cleanup(request, id);
    }
  });

  test('formulas that use preamble macros open in the formula editor and keep the macros as typed (#153)', async ({ page, request }) => {
    const doc = [
      '\\documentclass{article}',
      '\\usepackage{amsmath,amssymb}',
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}',
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
      '\\begin{document}',
      'Reals $x \\in \\R$ and $\\norm{v}$ and $\\argmax_i f$.',
      'plain end',
      '\\end{document}',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Macros', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const math = page.getByTestId('vis-math');
      await expect(math).toHaveCount(3);
      // KaTeX knows the macros too: no red fallback
      await expect(math.nth(0).locator('.katex-error')).toHaveCount(0);
      await expect(math.nth(1).locator('.katex-error')).toHaveCount(0);

      await math.nth(0).click();
      await appendInFormula(page, '+1');
      let expected = doc.replace('$x \\in \\R$', '$x \\in \\R+1$');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(1).click();
      await appendInFormula(page, '+1');
      expected = expected.replace('$\\norm{v}$', '$\\norm{v}+1$');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await page.getByTestId('vis-math').nth(2).click();
      await expect(page.getByTestId('math-popover')).toBeVisible();
      await page.getByTestId('math-popover-done').click();

      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(expected);
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('visual editor on a phone (VIS-21)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  test('the formula editor stays clear of the keyboard and controls are big enough to tap', async ({ page, request }) => {
    const filler = Array.from({ length: 40 }, (_, i) => `Filler line ${i}.`).join('\n');
    const id = await seedDoc(request, 'Visual Phone', `${filler}\nNear the bottom $x+y$ here.\n\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\nplain end\n`);
    try {
      await openProject(page, id);
      await page.getByTestId('sidebar-toggle').click(); // the editor, not the file list, fills the phone
      await page.locator('.cm-line', { hasText: 'plain end' }).tap();
      const math = page.getByTestId('vis-math');
      await math.scrollIntoViewIfNeeded();
      await math.tap();
      const pop = page.getByTestId('math-popover');
      await expect(pop).toBeVisible();
      await page.waitForTimeout(800); // the virtual keyboard slides in
      const { popBottom, limit } = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="math-popover"]')!.getBoundingClientRect();
        const kb = (window as unknown as { mathVirtualKeyboard?: { visible: boolean; boundingRect: DOMRect } }).mathVirtualKeyboard;
        const top = kb?.visible && kb.boundingRect.height ? kb.boundingRect.top : window.innerHeight;
        return { popBottom: p.bottom, limit: top };
      });
      expect(popBottom).toBeLessThanOrEqual(limit);
      await page.getByTestId('math-popover-source').tap();
      await page.locator('.cm-line', { hasText: 'plain end' }).tap();
      for (const testid of ['vis-table-addrow', 'vis-table-addcol', 'vis-table-source']) {
        const box = (await page.getByTestId(testid).boundingBox())!;
        expect(box.height, testid).toBeGreaterThanOrEqual(24);
      }
      for (const tab of await page.getByTestId('mode-toggle').getByRole('button').all()) {
        const box = await tab.boundingBox();
        if (box) expect(box.height).toBeGreaterThanOrEqual(24);
      }
    } finally {
      await cleanup(request, id);
    }
  });
});
