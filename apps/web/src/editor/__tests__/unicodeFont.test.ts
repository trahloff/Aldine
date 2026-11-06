import { describe, it, expect } from 'vitest';
import { UNICODE_FONT, unicodeFontPlan } from '../unicodeFont';

const apply = (text: string) => {
  const plan = unicodeFontPlan(text);
  if (plan.kind !== 'edit') return plan;
  let out = text;
  for (const c of [...plan.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

const FONT = `\\usepackage{fontspec}\n${UNICODE_FONT}`;

describe('a font with Greek and math symbols for XeLaTeX (vis-9)', () => {
  it('keeps fontenc and inputenc for pdfLaTeX and loads the font everywhere else, as Aldine\'s article template has them', () => {
    const doc = '\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath, amssymb}\n\\begin{document}\nα ≤ β\n\\end{document}\n';
    expect(apply(doc)).toBe(`\\documentclass[11pt]{article}\n\\usepackage{iftex}\n\\ifPDFTeX\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\else\n${FONT}\n\\fi\n\\usepackage{amsmath, amssymb}\n\\begin{document}\nα ≤ β\n\\end{document}\n`);
  });

  it('guards each fontenc or inputenc line on its own when other lines stand between them', () => {
    const doc = '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{graphicx}\n\\usepackage[utf8]{inputenc} % input\n\\begin{document}\nx\n\\end{document}\n';
    expect(apply(doc)).toBe(`\\documentclass{article}\n\\usepackage{iftex}\n\\ifPDFTeX\n\\usepackage[T1]{fontenc}\n\\fi\n\\usepackage{graphicx}\n\\ifPDFTeX\n\\usepackage[utf8]{inputenc} % input\n\\fi\n\\ifPDFTeX\\else\n${FONT}\n\\fi\n\\begin{document}\nx\n\\end{document}\n`);
  });

  it('adds the font after \\documentclass when nothing loads an encoding, and uses iftex when it is there', () => {
    expect(apply('\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n'))
      .toBe(`\\documentclass{article}\n\\usepackage{iftex}\n\\ifPDFTeX\\else\n${FONT}\n\\fi\n\\begin{document}\nx\n\\end{document}\n`);
    expect(apply('\\documentclass{article}\n\\usepackage{iftex}\n\\begin{document}\nx\n\\end{document}\n'))
      .toBe(`\\documentclass{article}\n\\usepackage{iftex}\n\\ifPDFTeX\\else\n${FONT}\n\\fi\n\\begin{document}\nx\n\\end{document}\n`);
  });

  it('only switches the engine where the document sets its own main font, and adds just the font to a bare fontspec', () => {
    expect(unicodeFontPlan('\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{TeX Gyre Pagella}\n\\begin{document}\n\\end{document}')).toEqual({ kind: 'keep' });
    expect(apply('\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\n\\end{document}'))
      .toBe(`\\documentclass{article}\n\\usepackage{fontspec}\n${UNICODE_FONT}\n\\begin{document}\n\\end{document}`);
    // a commented-out \setmainfont does not count
    expect(unicodeFontPlan('\\documentclass{article}\n% \\setmainfont{X}\n\\begin{document}\n\\end{document}').kind).toBe('edit');
  });

  it('names the line to change when fontenc shares it with other packages', () => {
    expect(unicodeFontPlan('\\documentclass{article}\n\\usepackage[T1]{fontenc}\\usepackage{xcolor}\n\\begin{document}\n\\end{document}'))
      .toEqual({ kind: 'manual', line: 2, text: '\\usepackage[T1]{fontenc}\\usepackage{xcolor}' });
    expect(unicodeFontPlan('\\documentclass{article}\n\\usepackage{inputenc,fontenc}\n\\begin{document}\n\\end{document}'))
      .toEqual({ kind: 'manual', line: 2, text: '\\usepackage{inputenc,fontenc}' });
  });
});
