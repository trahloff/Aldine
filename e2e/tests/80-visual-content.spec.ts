import { test, expect } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { createProject, openProject, cleanup, typeset } from './helpers';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const stored = async (request: APIRequestContext, id: string, path = 'main.tex') =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

/** Waits out the collab store debounce. */
async function expectStored(request: APIRequestContext, id: string, expected: string) {
  await expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(expected);
}

async function seedDoc(request: APIRequestContext, name: string, content: string, extra: Record<string, string> = {}) {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
  for (const [path, text] of Object.entries(extra)) await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content: text } });
  return id;
}

/** Pastes into whatever has focus, as a clipboard with these types would. */
const pasteHere = (page: Page, data: Record<string, string>) => page.evaluate((data) => {
  const dt = new DataTransfer();
  for (const [type, value] of Object.entries(data)) dt.setData(type, value);
  (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, data);

const TABLE = 'Before.\n\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\nplain end\n';

test.describe('visual editor: tables, formulas and pastes (d-visual-content)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
  });

  test('table cells show styles, formulas and escapes, and a \\multicolumn spans its columns (vis-13)', async ({ page, request }) => {
    const doc = [
      'Before.',
      '\\begin{tabular}{|l|c|r|}',
      '\\hline',
      '\\textbf{Model} & $p<0.05$ & 95\\% \\\\',
      '\\multicolumn{2}{|c|}{Wide head} & R\\&D~costs \\\\',
      '\\end{tabular}',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Cells Drawn', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const cells = page.getByTestId('vis-table').locator('td');
      await expect(cells).toHaveCount(5);
      await expect(cells.nth(0).locator('.cm-vis-b')).toHaveText('Model');
      await expect(cells.nth(1).locator('.katex')).toBeVisible();
      await expect(cells.nth(2)).toHaveText('95%');
      await expect(cells.nth(3)).toHaveAttribute('colspan', '2');
      await expect(cells.nth(3)).toHaveText('Wide head');
      await expect(cells.nth(4)).toHaveText('R&D\u00a0costs');
      await page.waitForTimeout(2500);
      expect(await stored(request, id)).toBe(doc);

      // a merged cell's editor edits its text; the \multicolumn around it stays
      await cells.nth(3).click();
      const input = page.getByTestId('vis-table-cell-input');
      await expect(input).toHaveValue('Wide head');
      await input.fill('Wide header');
      await input.press('Enter');
      await expectStored(request, id, doc.replace('{Wide head}', '{Wide header}'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('a % or & typed into a cell is escaped, formulas stay, and a pasted block fills cells and rows (vis-6)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Cell Escapes', TABLE);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      const input = page.getByTestId('vis-table-cell-input');
      await grid.locator('td', { hasText: /^a$/ }).click();
      await input.fill('91%');
      await input.press('Enter');
      await grid.locator('td', { hasText: /^b$/ }).click();
      await input.fill('R&D $x_1$');
      await input.press('Enter');
      let expected = TABLE.replace('a & b', '91\\% & R\\&D $x_1$');
      await expectStored(request, id, expected);
      await expect(grid.locator('tr')).toHaveCount(2);
      await expect(grid.locator('td').first()).toHaveText('91%');

      // a paste from a spreadsheet: tabs are cells, lines are rows, and the table grows to fit
      await grid.locator('td', { hasText: /^c$/ }).click();
      await pasteHere(page, { 'text/plain': 'X\tY\tZ 5%\r\n1\t2\t3\r\n' });
      expected = expected.replace('{ll}', '{lll}').replace('c & d \\\\\n', 'X & Y & Z 5\\% \\\\\n1 & 2 & 3 \\\\\n');
      await expectStored(request, id, expected);
      await expect(grid.locator('tr')).toHaveCount(3);

      // one piece pastes into the field, converted as a paste in Visual is
      await grid.locator('td', { hasText: /^Y$/ }).click();
      await pasteHere(page, { 'text/html': '<b>Bold</b> at 7%', 'text/plain': 'Bold at 7%' });
      await expect(input).toHaveValue('\\textbf{Bold} at 7\\%');
      await input.press('Enter');
      await expectStored(request, id, expected.replace('X & Y & Z', 'X & \\textbf{Bold} at 7\\% & Z'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('rows and columns are inserted, merged, split and deleted from a cell\'s menu, each undone in one step (vis-14)', async ({ page, request }) => {
    const doc = 'Before.\n\\begin{tabular}{|l|c|}\n\\hline\na & b \\\\\nc & d \\\\\n\\hline\n\\end{tabular}\nplain end\n';
    const id = await seedDoc(request, 'Visual Table Ops', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      const menu = page.getByTestId('vis-table-menu');
      const op = (name: string) => page.getByTestId(`vis-table-op-${name}`);

      await grid.locator('td', { hasText: /^a$/ }).click({ button: 'right' });
      await expect(menu).toBeVisible();
      await expect(page.getByTestId('vis-table-menu-cell')).toHaveText('Row 1, column 1');
      await expect(op('split')).toHaveAttribute('aria-disabled', 'true');
      await op('rowBelow').click();
      let expected = doc.replace('a & b \\\\\n', 'a & b \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);
      await expect(grid.locator('tr').nth(1).locator('td').first()).toBeFocused();
      // undo from the cell takes the whole row back
      await page.keyboard.press(`${MOD}+z`);
      await expectStored(request, id, doc);
      await expect(grid.locator('tr')).toHaveCount(2);

      await grid.locator('td', { hasText: /^b$/ }).click({ button: 'right' });
      await op('colRight').click();
      expected = doc.replace('{|l|c|}', '{|l|c|c|}').replace('a & b \\\\', 'a & b & \\\\').replace('c & d \\\\', 'c & d & \\\\');
      await expectStored(request, id, expected);
      await expect(grid.locator('tr').first().locator('td')).toHaveCount(3);

      await grid.locator('td', { hasText: /^a$/ }).click({ button: 'right' });
      await op('mergeRight').click();
      expected = expected.replace('a & b & \\\\', '\\multicolumn{2}{|l|}{a b} & \\\\');
      await expectStored(request, id, expected);
      await expect(grid.locator('td', { hasText: /^a b$/ })).toHaveAttribute('colspan', '2');
      await grid.locator('td', { hasText: /^a b$/ }).click({ button: 'right' });
      await op('split').click();
      expected = expected.replace('\\multicolumn{2}{|l|}{a b} & \\\\', 'a b & & \\\\');
      await expectStored(request, id, expected);

      // the bar's button acts on the cell chosen last; Shift+F10 opens the menu from the keyboard
      await grid.locator('td', { hasText: /^d$/ }).click();
      await page.keyboard.press('Escape');
      await page.getByTestId('vis-table-menu-button').click();
      await expect(page.getByTestId('vis-table-menu-cell')).toHaveText('Row 2, column 2');
      await op('deleteColumn').click();
      expected = expected.replace('{|l|c|c|}', '{|l|c|}').replace('a b & & \\\\', 'a b & \\\\').replace('c & d & \\\\', 'c & \\\\');
      await expectStored(request, id, expected);
      await grid.locator('td', { hasText: /^c$/ }).focus();
      await page.keyboard.press('Shift+F10');
      await expect(op('rowAbove')).toBeFocused();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowUp');
      await expect(op('deleteRow')).toBeFocused();
      await page.keyboard.press('Enter');
      expected = expected.replace('c & \\\\\n', '');
      await expectStored(request, id, expected);
      await expect(grid.locator('tr')).toHaveCount(1);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a table is filled from the keyboard: + row keeps focus, arrows move between cells, Tab in the last cell adds a row (vis-15)', async ({ page, request }) => {
    const id = await seedDoc(request, 'Visual Table Typing', TABLE);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const grid = page.getByTestId('vis-table');
      const input = page.getByTestId('vis-table-cell-input');
      const cell = (r: number, c: number) => grid.locator('tr').nth(r).locator('td').nth(c);

      await page.getByTestId('vis-table-addrow').focus();
      await page.keyboard.press('Enter');
      let expected = TABLE.replace('c & d \\\\\n', 'c & d \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);
      await expect(cell(2, 0)).toBeFocused();
      await page.keyboard.type('e');
      await expect(input).toHaveValue('e');
      await page.keyboard.press('Tab');
      await expect(input).toHaveAttribute('aria-label', 'Row 3, column 2');
      await page.keyboard.type('f');
      // Tab in the last cell writes it, adds a row and opens its first cell
      await page.keyboard.press('Tab');
      expected = TABLE.replace('c & d \\\\\n', 'c & d \\\\\ne &  f \\\\\n&  \\\\\n');
      await expectStored(request, id, expected);
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('aria-label', 'Row 4, column 1');
      await page.keyboard.press('Escape');

      // arrows between cells, focused or open
      await cell(0, 0).focus();
      await page.keyboard.press('ArrowRight');
      await expect(cell(0, 1)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(cell(1, 1)).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(cell(1, 0)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue('c');
      await page.keyboard.press('ArrowDown');
      await expect(input).toHaveValue('e');
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowRight');
      await expect(input).toHaveValue('f');
      await page.keyboard.press('ArrowUp');
      await expect(input).toHaveValue('d');
      await page.keyboard.press('Escape');
      // up from the first row leaves the grid for the text above it
      await cell(0, 0).focus();
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('.cm-content')).toBeFocused();
      await page.keyboard.type('!');
      await page.waitForTimeout(500);
      expect(await stored(request, id)).toBe(expected.replace('Before.\n', 'Before.\n!'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('a numbered equation opens in the formula editor and keeps its \\label; one that cannot says why (vis-16)', async ({ page, request }) => {
    const doc = [
      'Text.',
      '\\begin{equation}',
      '  E = mc^2 \\label{eq:e}',
      '\\end{equation}',
      '\\begin{equation}\\label{eq:f}',
      '  a + b',
      '\\end{equation}',
      '\\begin{align}',
      '  a &= b',
      '\\end{align}',
      'plain end',
      '',
    ].join('\n');
    const id = await seedDoc(request, 'Visual Labelled Equations', doc);
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const math = page.getByTestId('vis-math');
      await expect(math).toHaveCount(3);
      const append = async (n: number, text: string) => {
        await page.locator('.cm-line', { hasText: 'plain end' }).click();
        await math.nth(n).click();
        await expect(page.getByTestId('math-field')).toBeFocused();
        await page.keyboard.press('End');
        await page.keyboard.type(text);
        await page.getByTestId('math-popover-done').click();
        await expect(page.getByTestId('math-popover')).toHaveCount(0);
      };
      await append(0, '+1');
      let expected = doc.replace('E = mc^2 \\label', 'E = mc^2+1 \\label');
      await expectStored(request, id, expected);
      await append(1, '+c');
      expected = expected.replace('  a + b\n', '  a + b+c\n');
      await expectStored(request, id, expected);

      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      await math.nth(2).click();
      await expect(page.getByTestId('toasts')).toContainText('This formula has alignment (& or \\\\), so it opens in the source');
      await expect(page.getByTestId('math-popover')).toHaveCount(0);
      await expect(page.locator('.cm-content')).toContainText('a &= b');
    } finally {
      await cleanup(request, id);
    }
  });

  test('macros from an \\input file and from \\def render, and a changed file is read again (vis-17)', async ({ page, request }) => {
    const doc = '\\documentclass{article}\n\\usepackage{bm}\n\\input{math_commands}\n\\begin{document}\nVectors $\\vx + \\mA$ and $\\vy$ here.\nplain end\n\\end{document}\n';
    const commands = '% notation\n\\def\\vx{{\\bm{x}}}\n\\newcommand{\\mA}{\\bm{A}}\n';
    const id = await seedDoc(request, 'Visual Input Macros', doc, { 'math_commands.tex': commands });
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'plain end' }).click();
      const math = page.getByTestId('vis-math');
      await expect(math).toHaveCount(2);
      await expect(math.nth(0)).toHaveAttribute('title', /^Edit formula/);
      // a command defined nowhere is drawn muted, and its title says why
      await expect(math.nth(1)).toHaveAttribute('title', "Can't draw \\vy: not defined in the preamble or in the files it inputs, so shown as written.");

      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'math_commands.tex', content: `${commands}\\def\\vy{{\\bm{y}}}\n` } });
      await expect(math.nth(1)).toHaveAttribute('title', /^Edit formula/, { timeout: 20_000 });
      await page.waitForTimeout(1000);
      expect(await stored(request, id)).toBe(doc);
    } finally {
      await cleanup(request, id);
    }
  });

  test('Word lists and numbered headings, superscripts, deleted text, web formulas and Greek letters paste right (vis-18, vis-19, vis-21, vis-9)', async ({ page, request }) => {
    const doc = '\\documentclass{article}\n\\begin{document}\nprose here\n\\end{document}\n';
    const id = await seedDoc(request, 'Visual Rich Pastes', doc);
    const item = (level: number, marker: string, text: string) =>
      `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;
    const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><h1 style='margin-left:21.6pt;text-indent:-21.6pt;mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Introduction<o:p></o:p></h1>${item(1, '·', 'First')}${item(2, 'o', 'Nested')}<p class=MsoNormal>At 10<sup>-3</sup> s we <del cite="mailto:a">never </del>saw <s>it</s>.<o:p></o:p></p><!--EndFragment--></body></html>`;
    const katex = '<p>So <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">E=mc2</span></span></span> holds.</p>';
    try {
      await openProject(page, id);
      await page.locator('.cm-line', { hasText: 'prose here' }).click();
      await page.keyboard.press('End');
      await pasteHere(page, { 'text/html': word, 'text/plain': '1 Introduction\n· First\no Nested\nAt 10-3 s we saw it.' });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\section{Introduction}\n\n\\begin{itemize}\n\\item First\n\\begin{itemize}\n\\item Nested\n\\end{itemize}\n\\end{itemize}\nAt 10\\textsuperscript{-3} s we saw it.');
      await page.keyboard.press('Enter');
      await pasteHere(page, { 'text/html': katex, 'text/plain': 'So E=mc2E=mc^2 holds.' });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('So $E=mc^2$ holds.');
      await pasteHere(page, { 'text/plain': ' with p ≤ 0.05 for α' });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('holds. with p \\ensuremath{\\le} 0.05 for \\ensuremath{\\alpha}');
    } finally {
      await cleanup(request, id);
    }
  });

  const UNICODE_DOC = '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\begin{document}\nThe angle α ≤ β.\n\\end{document}\n';
  const WITH_FONT = UNICODE_DOC.replace('\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n', [
    '\\usepackage{iftex}', '\\ifPDFTeX', '\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}', '\\else', '\\usepackage{fontspec}',
    '\\setmainfont{DejaVuSerif}[Extension=.ttf, BoldFont=*-Bold, ItalicFont=*-Italic, BoldItalicFont=*-BoldItalic]', '\\fi', '',
  ].join('\n'));

  /** Typesets the source-mode project `id` and waits for pdfLaTeX's Unicode error, then chooses the font action. */
  async function switchToUnicodeFont(page: Page, request: APIRequestContext, id: string) {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'source'));
    await openProject(page, id);
    await typeset(page);
    await expect(page.getByTestId('problem-unicode')).toBeVisible({ timeout: 120_000 });
    await page.getByTestId('problem-engine-font').click();
    await expectStored(request, id, WITH_FONT);
    await expect.poll(async () => (await (await request.get(`/api/projects/${id}`)).json()).engine, { timeout: 20_000 }).toBe('xelatex');
  }

  test('"Typeset with XeLaTeX and a font" guards fontenc for pdfLaTeX and loads the font, as one undo step (vis-9)', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await seedDoc(request, 'Visual Unicode Font', UNICODE_DOC);
    try {
      await switchToUnicodeFont(page, request, id);
      await page.locator('.cm-line', { hasText: 'The angle' }).click();
      await page.keyboard.press(`${MOD}+z`);
      await expectStored(request, id, UNICODE_DOC);
      await page.keyboard.press(`${MOD}+Shift+z`);
      await expectStored(request, id, WITH_FONT);
    } finally {
      await cleanup(request, id);
    }
  });

  test('with that font XeLaTeX prints the Greek and math characters (vis-9)', async ({ page, request }) => {
    // BasicTeX has no DejaVu; the compiler image has it (with ConTeXt)
    test.skip(!process.env.CI, 'needs the compiler image\'s DejaVu fonts, which BasicTeX lacks');
    test.setTimeout(240_000);
    const id = await seedDoc(request, 'Visual Unicode Font Typeset', UNICODE_DOC);
    try {
      await switchToUnicodeFont(page, request, id);
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      await expect(page.getByTestId('problem-unicode')).toHaveCount(0);
      await expect(page.getByTestId('problem-warning').filter({ hasText: 'Missing character' })).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('pdfLaTeX stopping at a Greek letter offers XeLaTeX and LuaLaTeX, and the switch says when the font lacks it (vis-9)', async ({ page, request }) => {
    test.setTimeout(240_000);
    const doc = '\\documentclass{article}\n\\begin{document}\nThe angle α.\n\\end{document}\n';
    const id = await seedDoc(request, 'Visual Unicode Engine', doc);
    try {
      await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'source'));
      await openProject(page, id);
      await typeset(page);
      const row = page.getByTestId('problem-unicode');
      await expect(row).toBeVisible({ timeout: 120_000 });
      await expect(row).toContainText('pdfLaTeX can’t typeset “α”');
      await expect(page.getByTestId('problem-engine-lualatex')).toHaveText('Typeset with LuaLaTeX');
      await page.getByTestId('problem-engine-xelatex').click();
      await expect.poll(async () => (await (await request.get(`/api/projects/${id}`)).json()).engine, { timeout: 20_000 }).toBe('xelatex');
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      if ((await page.getByTestId('errors-panel').getAttribute('data-open')) === 'false') await page.getByTestId('problems-toggle').click();
      await expect(page.getByTestId('problem-warning').filter({ hasText: 'Missing character: There is no α' })).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('problem-warning').filter({ hasText: 'Missing character' })).toContainText('The font has no “α”');
    } finally {
      await cleanup(request, id);
    }
  });
});
