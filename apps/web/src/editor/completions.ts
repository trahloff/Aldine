import type { Completion, CompletionContext, CompletionSource } from '@codemirror/autocomplete';
import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { latexCompletions } from 'codemirror-lang-latex';
import { api, type TreeEntry } from '../api';
import { preambleMacros } from './visual/preamble';
import { afterLineBreak, applyCommand } from './latexExtras';

/**
 * Everyday commands codemirror-lang-latex does not list, with the number of
 * mandatory arguments their completion brings braces for.
 */
const EVERYDAY: Record<string, number> = {
  // text
  footnote: 1, footnotemark: 0, footnotetext: 1, url: 1, href: 2, thanks: 1, and: 0,
  today: 0, LaTeX: 0, TeX: 0, ldots: 0, dots: 0, textsuperscript: 1, textsubscript: 1,
  textnormal: 1, textup: 1, textsl: 1, mbox: 1, fbox: 1, textbackslash: 0,
  centering: 0, raggedright: 0, raggedleft: 0, noindent: 0, newline: 0, linebreak: 0,
  newpage: 0, clearpage: 0, pagebreak: 0, smallskip: 0, medskip: 0, bigskip: 0, hfill: 0, vfill: 0,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0, Large: 0, LARGE: 0, huge: 0, Huge: 0,
  textwidth: 0, linewidth: 0, columnwidth: 0, listoffigures: 0, listoftables: 0,
  printbibliography: 0, addbibresource: 1, subfile: 1, lstinputlisting: 1, includepdf: 1, graphicspath: 1,
  captionof: 2, setlength: 2, addtolength: 2, newtheorem: 2, providecommand: 2, DeclareMathOperator: 2, hypersetup: 1,
  // math
  cdot: 0, cdots: 0, vdots: 0, ddots: 0, times: 0, div: 0, pm: 0, mp: 0, le: 0, ge: 0, ne: 0,
  to: 0, gets: 0, iff: 0, implies: 0, land: 0, lor: 0, lnot: 0, neg: 0, propto: 0, parallel: 0, perp: 0,
  mid: 0, colon: 0, circ: 0, bullet: 0, star: 0, ast: 0, dagger: 0, oplus: 0, otimes: 0, wedge: 0, vee: 0,
  top: 0, bot: 0, nabla: 0, ell: 0, hbar: 0, Re: 0, Im: 0, aleph: 0, prime: 0, angle: 0,
  langle: 0, rangle: 0, lfloor: 0, rfloor: 0, lceil: 0, rceil: 0, left: 0, right: 0,
  bigcup: 0, bigcap: 0, oint: 0, iint: 0, iiint: 0, supset: 0, supseteq: 0, subsetneq: 0, ni: 0,
  leftrightarrow: 0, Leftrightarrow: 0, longrightarrow: 0, Longrightarrow: 0, uparrow: 0, downarrow: 0,
  vartheta: 0, varrho: 0, varsigma: 0, varpi: 0,
  arg: 0, deg: 0, ker: 0, Pr: 0, bmod: 0, pmod: 1,
  mathbf: 1, mathcal: 1, mathbb: 1, mathrm: 1, mathit: 1, mathsf: 1, mathtt: 1, mathfrak: 1, mathscr: 1,
  boldsymbol: 1, bm: 1, text: 1, operatorname: 1, dfrac: 2, tfrac: 2, binom: 2,
  overrightarrow: 1, overleftarrow: 1, underbrace: 1, overbrace: 1, widehat: 1, widetilde: 1,
  stackrel: 2, overset: 2, underset: 2,
};

/**
 * Where a prefix fits several, the package's commands (boost 1) come first,
 * \textbf before \textbackslash, except for the ones meant more often than
 * their neighbours: \foot is \footnote before \footcite.
 */
const BOOST: Record<string, number> = { footnote: 2, url: 2, mathbf: 1, mathbb: 1, mathcal: 1 };

/** What codemirror-lang-latex offers already: listing a name twice would show it twice. */
const PACKAGE = new Set([...latexCompletions.commands, ...latexCompletions.mathCommands]);

/** Commands whose first argument is a project file, listed once the braces are in. */
const LISTS_FILES = new Set(['addbibresource', 'subfile', 'lstinputlisting', 'includepdf']);

const everydayOptions: Completion[] = Object.entries(EVERYDAY)
  .filter(([name]) => !PACKAGE.has(`\\${name}`))
  .map(([name, args]) => ({
    label: `\\${name}`,
    type: 'function',
    boost: BOOST[name] ?? 0,
    ...(args ? { apply: applyCommand(`\\${name}`, args, LISTS_FILES.has(name)) } : {}),
  }));

/** The labels the everyday list offers, for tests. */
export const everydayLabels = (): string[] => everydayOptions.map((o) => o.label);

const commandWord = (ctx: CompletionContext) => (afterLineBreak(ctx) ? null : ctx.matchBefore(/\\[a-zA-Z]*$/));

export const everydayCompletionSource: CompletionSource = (ctx) => {
  const word = commandWord(ctx);
  return word ? { from: word.from, options: everydayOptions, validFor: /^\\[a-zA-Z]*$/ } : null;
};

// ---- the project's files, for the commands that name one ----

let projectFiles: { key: string; rootFile: string; files: TreeEntry[] } | null = null;

/** The open branch's file listing and main document, as the editor page last loaded them. */
export function setCompletionFiles(projectId: string, branch: string, rootFile: string | undefined, files: TreeEntry[]): void {
  projectFiles = { key: `${projectId}::${branch}`, rootFile: rootFile ?? '', files };
}

function filesOf(projectId: string, branch: string) {
  return projectFiles?.key === `${projectId}::${branch}` ? projectFiles : null;
}

/** `to` (a project path) as written from the directory `from` ('' is the project's top). */
export function relativePath(from: string, to: string): string {
  const a = from ? from.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

interface PathRule {
  /** The files it takes; null: any text file. */
  accept: RegExp | null;
  /** An extension the command adds itself, left out of the path. */
  strip?: RegExp;
  /** A comma-separated list: the caret stays inside the braces for the next one. */
  list?: boolean;
  /** Never the file being edited or the main document: TeX would read it into itself. */
  notSelf?: boolean;
}

const PATH_RULES: Record<string, PathRule> = {
  includegraphics: { accept: /\.(pdf|png|jpe?g|eps)$/i },
  includepdf: { accept: /\.pdf$/i },
  input: { accept: /\.(tex|tikz|pgf)$/i, notSelf: true },
  include: { accept: /\.tex$/i, strip: /\.tex$/i, notSelf: true },
  includeonly: { accept: /\.tex$/i, strip: /\.tex$/i, list: true, notSelf: true },
  subfile: { accept: /\.tex$/i, strip: /\.tex$/i, notSelf: true },
  bibliography: { accept: /\.bib$/i, strip: /\.bib$/i, list: true },
  addbibresource: { accept: /\.bib$/i },
  lstinputlisting: { accept: null },
  verbatiminput: { accept: null },
};

/** A path command up to the caret; group 2 is its argument typed so far. */
const PATH_RE = new RegExp(`\\\\(${Object.keys(PATH_RULES).join('|')})\\*?(?:\\[[^\\]]*\\])*\\{([^{}]*)$`);

/**
 * The paths a command's argument can take, as TeX finds them: relative to
 * the main document's directory, where typesetting runs.
 */
export function pathCandidates(command: string, files: TreeEntry[], rootFile: string, currentFile: string): string[] {
  const rule = PATH_RULES[command];
  if (!rule) return [];
  const rootDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const f of files) {
    if (f.type !== 'file' || f.path.split('/').some((part) => part.startsWith('.'))) continue;
    if (rule.accept ? !rule.accept.test(f.path) : f.binary) continue;
    if (rule.notSelf && (f.path === currentFile || f.path === rootFile)) continue;
    const rel = relativePath(rootDir, f.path);
    out.push(rule.strip ? rel.replace(rule.strip, '') : rel);
  }
  return out.sort((x, y) => x.localeCompare(y));
}

function applyPath(list: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const hop = !list && view.state.sliceDoc(to, to + 1) === '}';
    view.dispatch({
      changes: { from, to, insert: completion.label },
      selection: { anchor: from + completion.label.length + (hop ? 1 : 0) },
      userEvent: 'input.complete',
    });
  };
}

export function pathCompletionSource(projectId: string, branch: string, currentFile: () => string): CompletionSource {
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = PATH_RE.exec(ctx.state.sliceDoc(line.from, ctx.pos));
    const project = filesOf(projectId, branch);
    if (!m || !project) return null;
    const rule = PATH_RULES[m[1]];
    const typed = rule.list ? m[2].slice(m[2].lastIndexOf(',') + 1).replace(/^\s+/, '') : m[2];
    const apply = applyPath(!!rule.list);
    const options = pathCandidates(m[1], project.files, project.rootFile, currentFile())
      .map((label): Completion => ({ label, type: 'text', apply }));
    if (!options.length) return null;
    return { from: ctx.pos - typed.length, options, validFor: /^[^{},]*$/ };
  };
}

// ---- the paper's own macros ----

export interface PaperMacro { name: string; args: number; def?: string }

/**
 * The macros a LaTeX source defines: what the Visual mode's preamble reader
 * takes (\newcommand, \renewcommand, \providecommand, \DeclareMathOperator),
 * and the forms it leaves out because a formula can't use them: an optional
 * first argument, \def and \NewDocumentCommand.
 */
export function macrosIn(text: string): PaperMacro[] {
  const code = text.replace(/(^|[^\\])%.*$/gm, '$1');
  const found = new Map<string, PaperMacro>();
  for (const [name, d] of Object.entries(preambleMacros(code).defs)) found.set(name, { name, args: d.args, def: d.def });
  const add = (name: string, args: number) => { if (!found.has(name)) found.set(name, { name, args }); };
  for (const m of code.matchAll(/\\(?:re)?(?:new|provide)command\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*\[\s*(\d)\s*\]\s*\[/g)) add(m[1], Math.max(0, Number(m[2]) - 1));
  for (const m of code.matchAll(/\\[gex]?def\s*\\([A-Za-z]+)((?:#\d)*)\s*\{/g)) add(m[1], (m[2].match(/#/g) ?? []).length);
  for (const m of code.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*\{([^}]*)\}/g)) add(m[1], (m[2].match(/\bm\b/g) ?? []).length);
  return [...found.values()];
}

/** Sources read for macros: the paper's own .tex and .sty files, the large ones left out. */
const MACRO_FILE = /\.(tex|sty)$/i;
const MACRO_FILE_MAX_BYTES = 512 * 1024;
const MACRO_FILES_MAX = 80;
/** How long a file read without a modification time stands for it. */
const MACRO_TTL_MS = 30_000;

const fileMacros = new Map<string, { version: string; at: number; macros: PaperMacro[]; document: boolean }>();
const reading = new Map<string, Promise<void>>();
const docMacros = new WeakMap<Text, PaperMacro[]>();

/** A file with \documentclass outside a comment: one that typesets on its own. */
export const isDocument = (text: string) => /^[^%\n]*\\documentclass\b/m.test(text);

/** The project's .tex and .sty files as last read, each read again once it has changed. */
async function readSources(projectId: string, branch: string) {
  const project = filesOf(projectId, branch);
  if (!project) return [];
  const sources = project.files
    .filter((f) => f.type === 'file' && MACRO_FILE.test(f.path) && !(f.size && f.size > MACRO_FILE_MAX_BYTES))
    .slice(0, MACRO_FILES_MAX);
  await Promise.all(sources.map((f) => {
    const key = `${project.key}::${f.path}`;
    const version = String(f.mtime ?? '');
    const have = fileMacros.get(key);
    if (have && have.version === version && (f.mtime != null || Date.now() - have.at < MACRO_TTL_MS)) return undefined;
    const inFlight = reading.get(`${key}@${version}`);
    if (inFlight) return inFlight;
    const read = api.readFile(projectId, branch, f.path)
      .then((text) => { fileMacros.set(key, { version, at: Date.now(), macros: macrosIn(text), document: isDocument(text) }); })
      .catch(() => { /* the file stays as last read */ })
      .finally(() => reading.delete(`${key}@${version}`));
    reading.set(`${key}@${version}`, read);
    return read;
  }));
  return sources.map((f) => ({ path: f.path, info: fileMacros.get(`${project.key}::${f.path}`) }));
}

async function projectMacros(projectId: string, branch: string): Promise<Array<PaperMacro & { file: string }>> {
  return (await readSources(projectId, branch)).flatMap(({ path, info }) => (info?.macros ?? []).map((m) => ({ ...m, file: path })));
}

/** The .tex files that can be a main document: the ones with \documentclass. */
export async function mainDocuments(projectId: string, branch: string): Promise<string[]> {
  return (await readSources(projectId, branch)).filter(({ path, info }) => /\.tex$/i.test(path) && info?.document).map(({ path }) => path);
}

export function macroCompletionSource(projectId: string, branch: string, currentFile: () => string): CompletionSource {
  return async (ctx) => {
    const word = commandWord(ctx);
    if (!word) return null;
    let here = docMacros.get(ctx.state.doc);
    if (!here) docMacros.set(ctx.state.doc, (here = macrosIn(ctx.state.doc.toString())));
    const there = await projectMacros(projectId, branch);
    const cur = currentFile();
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const m of [...here.map((x) => ({ ...x, file: cur })), ...there.filter((x) => x.file !== cur)]) {
      const label = `\\${m.name}`;
      if (seen.has(m.name) || PACKAGE.has(label) || EVERYDAY[m.name] !== undefined) continue;
      seen.add(m.name);
      options.push({
        label,
        type: 'function',
        boost: 2,
        detail: m.file === cur ? undefined : m.file,
        info: m.def ? `${label} → ${m.def.length > 80 ? `${m.def.slice(0, 80)}…` : m.def}` : undefined,
        ...(m.args ? { apply: applyCommand(label, m.args, false) } : {}),
      });
    }
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^\\[a-zA-Z]*$/ };
  };
}
