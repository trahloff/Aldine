import { describe, it, expect } from 'vitest';
import { highlightTree, tags as t } from '@lezer/highlight';
import { aldineHighlight, latexHighlightLanguage } from '../latexHighlight';

const cls = (...tags: Parameters<typeof aldineHighlight.style>[0]) => aldineHighlight.style(tags) ?? '';
const COMMAND = cls(t.keyword);
const LABEL = cls(t.labelName);
const HEADING = cls(t.heading);

/** The highlight classes of every character of `src`. */
function classesOf(src: string): string[] {
  const out: string[] = Array(src.length).fill('');
  highlightTree(latexHighlightLanguage.parser.parse(src), aldineHighlight, (from, to, c) => {
    for (let i = from; i < to; i++) out[i] = c;
  });
  return out;
}

/** The class set on each character of the first `needle` in `src`. */
function at(src: string, needle: string, nth = 0): string[] {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = src.indexOf(needle, from + 1);
  if (from < 0) throw new Error(`${needle} not in ${src}`);
  return classesOf(src).slice(from, from + needle.length);
}

const has = (classes: string[], c: string) => classes.every((x) => x.split(' ').includes(c));

describe('LaTeX highlighting', () => {
  it('distinct tags color differently', () => {
    expect(COMMAND).not.toBe('');
    expect(LABEL).not.toBe('');
    expect(new Set([COMMAND, LABEL, HEADING]).size).toBe(3);
  });

  it.each(['\\centering', '\\caption', '\\item', '\\hline', '\\textbf', '\\textit', '\\emph', '\\footnote',
    '\\includegraphics', '\\usepackage', '\\documentclass', '\\maketitle', '\\newcommand', '\\def', '\\left',
    '\\toprule', '\\multicolumn', '\\foo', '\\\\', '\\%', '\\&', '\\@'])('%s gets the command color', (cmd) => {
    const src = `${cmd}{x} y`;
    expect(has(at(src, cmd), COMMAND)).toBe(true);
    expect(at(src, 'y')[0]).toBe('');
  });

  it.each(['\\cite', '\\citep', '\\citet', '\\citeauthor', '\\parencite', '\\textcite', '\\autocite', '\\ref', '\\eqref',
    '\\cref', '\\label'])('%s gets the reference color', (cmd) => {
    expect(has(at(`${cmd}{key}`, cmd), LABEL)).toBe(true);
  });

  it('keeps sectioning distinct', () => {
    expect(has(at('\\section{Intro}', '\\section'), HEADING)).toBe(true);
    expect(has(at('\\section*{Intro}', '\\section*'), HEADING)).toBe(true);
  });

  it('colors the star of starred commands with the command', () => {
    expect(has(at('\\cite*{k}', '\\cite*'), LABEL)).toBe(true);
    expect(has(at('\\caption*{c}', '\\caption*'), COMMAND)).toBe(true);
  });

  it('styles the argument of \\textbf, \\textit and \\emph, and colors only the name', () => {
    const src = '\\textbf{bold} \\textit{it} \\emph{em}';
    for (const name of ['\\textbf', '\\textit', '\\emph']) expect(has(at(src, name), COMMAND)).toBe(true);
    expect(has(at(src, 'bold'), cls(t.strong))).toBe(true);
    expect(has(at(src, 'it', 1), cls(t.emphasis))).toBe(true);
    expect(has(at(src, 'em', 1), cls(t.emphasis))).toBe(true);
    expect(at(src, 'bold').some((c) => c.includes(COMMAND))).toBe(false);
    expect(at(src, '\\textbf').some((c) => c.includes(cls(t.strong)))).toBe(false);
  });

  it('nests commands inside formatted arguments', () => {
    const c = at('\\textit{see \\cite{k}}', '\\cite');
    expect(has(c, LABEL) && has(c, cls(t.emphasis))).toBe(true);
  });

  it('handles optional arguments', () => {
    const item = '\\item[label] text';
    expect(has(at(item, '\\item'), COMMAND)).toBe(true);
    expect(at(item, 'label').some((c) => c.includes(COMMAND))).toBe(false);
    const cite = '\\cite[p.~3]{key}';
    expect(has(at(cite, '\\cite'), LABEL)).toBe(true);
    expect(at(cite, 'key').some((c) => c.includes(LABEL))).toBe(false);
    const br = 'a \\\\[2pt] b';
    expect(has(at(br, '\\\\'), COMMAND)).toBe(true);
    expect(at(br, '2pt').some((c) => c.includes(COMMAND))).toBe(false);
  });

  it('leaves \\verb content alone', () => {
    const src = '\\verb|\\foo| x';
    expect(has(at(src, '\\verb'), COMMAND)).toBe(true);
    expect(at(src, '\\foo').some((c) => c.includes(COMMAND))).toBe(false);
  });

  it('colors commands inside math', () => {
    const src = '$\\alpha + \\frac{a}{b}$ \\[ \\sum_i \\]';
    for (const cmd of ['\\alpha', '\\frac', '\\sum']) expect(has(at(src, cmd), COMMAND)).toBe(true);
    expect(has(at(src, '\\['), cls(t.processingInstruction))).toBe(true);
  });

  it('keeps environments and definitions distinct', () => {
    const env = '\\begin{figure}\\end{figure}';
    expect(has(at(env, '\\begin'), COMMAND)).toBe(true);
    expect(has(at(env, 'figure'), cls(t.className))).toBe(true);
    const def = '\\newcommand{\\R}{\\mathbb{R}}';
    expect(has(at(def, '\\newcommand'), COMMAND)).toBe(true);
    expect(has(at(def, '\\R'), cls(t.string))).toBe(true);
  });

  it('keeps comments distinct', () => {
    expect(has(at('% \\cite{x}', '\\cite'), cls(t.comment))).toBe(true);
    expect(at('% \\cite{x}', '\\cite').some((c) => c.includes(LABEL))).toBe(false);
  });
});
