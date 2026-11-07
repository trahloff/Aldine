import { Completion, CompletionContext, CompletionSource, pickedCompletion, startCompletion } from '@codemirror/autocomplete';
import { EditorState, Extension, Prec } from '@codemirror/state';
import { hoverTooltip, EditorView, type HoverTooltipSource } from '@codemirror/view';
import { api, BibEntry } from '../api';

/**
 * Accepting a key inside \cite{…}/\ref{…} hops the cursor over the auto-closed
 * brace — otherwise a touch-typist's next words land inside the argument and
 * the mangled key ships silently (biblatex downgrades it to a warning).
 */
function applyKeyAndHopBrace(view: EditorView, completion: Completion, from: number, to: number): void {
  const closes = view.state.sliceDoc(to, to + 1) === '}';
  view.dispatch({
    changes: { from, to, insert: completion.label },
    selection: { anchor: from + completion.label.length + (closes ? 1 : 0) },
    userEvent: 'input.complete',
  });
}

/** \cite{…} and \ref{…} up to the caret; group 1 is the argument typed so far. */
const CITE_RE = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const REF_RE = /\\(?:auto|c|C|eq|page|name|v|V)?ref\*?\{([^}]*)$/;

/** Offered with their braces, so each must match CITE_RE or REF_RE once `{` follows. */
const KEY_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'nocite',
  'parencite', 'textcite', 'autocite', 'footcite', 'fullcite',
  'ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref', 'nameref', 'vref', 'Vref',
].map((name) => `\\${name}`));

/**
 * The mandatory arguments of the package's commands, whose completions
 * insert that many pairs of braces. A command missing here inserts its name
 * alone: it takes no argument (\item, \alpha, \hline), or its argument has a
 * flow of its own (\begin, \end).
 */
const ARGUMENTS: Record<string, number> = {
  '\\documentclass': 1, '\\usepackage': 1, '\\title': 1, '\\author': 1, '\\date': 1,
  '\\bibliography': 1, '\\bibliographystyle': 1,
  '\\part': 1, '\\chapter': 1, '\\section': 1, '\\subsection': 1, '\\subsubsection': 1, '\\paragraph': 1, '\\subparagraph': 1,
  '\\label': 1, '\\bibitem': 1,
  '\\textbf': 1, '\\textit': 1, '\\texttt': 1, '\\textsf': 1, '\\textrm': 1, '\\textsc': 1, '\\emph': 1, '\\underline': 1,
  '\\textcolor': 2, '\\colorbox': 2,
  '\\includegraphics': 1, '\\caption': 1,
  '\\frac': 2, '\\sqrt': 1,
  '\\hspace': 1, '\\vspace': 1,
  '\\cline': 1, '\\multicolumn': 3, '\\multirow': 3,
  '\\newcommand': 2, '\\renewcommand': 2, '\\newenvironment': 3, '\\renewenvironment': 3,
  '\\input': 1, '\\include': 1, '\\includeonly': 1,
  '\\hat': 1, '\\tilde': 1, '\\bar': 1, '\\vec': 1, '\\dot': 1, '\\ddot': 1, '\\overline': 1, '\\mathop': 1,
};

/**
 * Accepting a command inserts its braces with the caret in the first pair;
 * one whose argument has its own completions (a citation key, a label, a
 * package, a file) lists them at once. Renaming the command of an existing one
 * (`\textb|{x}`, `\ci|[p.~3]{key}`) inserts the name alone.
 */
export function applyCommand(name: string, args: number, list: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const bare = /^[{[*]/.test(view.state.sliceDoc(to, to + 1));
    view.dispatch({
      changes: { from, to, insert: bare ? name : name + '{}'.repeat(args) },
      selection: { anchor: from + name.length + (bare ? 0 : 1) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    });
    if (!bare && list) startCompletion(view);
  };
}

/** Commands whose first argument has a list of its own: packages, and the project's files. */
const LISTED_ARGUMENT = new Set(['\\usepackage', '\\includegraphics', '\\input', '\\include', '\\includeonly', '\\bibliography']);

const commandApplies = new Map(Object.entries(ARGUMENTS).map(([name, args]) => [name, applyCommand(name, args, LISTED_ARGUMENT.has(name))]));

/** The package's command (or `\section{...}` snippet) with an apply that brings its braces. */
function withArguments(option: Completion): Completion {
  if (typeof option.apply !== 'string') return option;
  const apply = commandApplies.get(option.label.replace(/\{\.\.\.\}$/, ''));
  return apply ? { ...option, apply } : option;
}

/**
 * The caret's backslash ends an even run: `\\` is a line break, and what
 * follows it is no command name (`a & b \\` and Enter ends the row).
 */
export function afterLineBreak(ctx: CompletionContext): boolean {
  const run = ctx.matchBefore(/\\+[a-zA-Z]*$/);
  return !!run && /^\\+/.exec(run.text)![0].length % 2 === 0;
}

const keyCommandOptions: Completion[] = [...KEY_COMMANDS].map((label) => ({ label, type: 'function', boost: 1, apply: applyCommand(label, 1, true) }));

export const keyCommandCompletionSource: CompletionSource = (ctx) => {
  if (afterLineBreak(ctx)) return null;
  const word = ctx.matchBefore(/\\[a-zA-Z]*$/);
  return word ? { from: word.from, options: keyCommandOptions, validFor: /^\\[a-zA-Z]*$/ } : null;
};

/**
 * codemirror-lang-latex's completions as the editor offers them: without its
 * \cite and \ref entries (keyCommandCompletionSource has them, with braces),
 * none after `\\`, and its commands that take arguments bring their braces.
 */
export function latexPackageCompletions(source: CompletionSource): CompletionSource {
  return async (ctx) => {
    if (afterLineBreak(ctx)) return null;
    const result = await source(ctx);
    return result && { ...result, options: result.options.filter((o) => !KEY_COMMANDS.has(o.label)).map(withArguments) };
  };
}

/**
 * Only brackets pair as they are typed: `'` closes LaTeX quotes (``x'') and
 * marks primes (f''), and `"` is a babel shorthand, so a second one there
 * would print. A .bib file still pairs `"` around a field value.
 */
export function latexCloseBrackets(filePath: string): Extension {
  const brackets = ['(', '[', '{', ...(/\.bib$/i.test(filePath) ? ['"'] : [])];
  return Prec.high(EditorState.languageData.of(() => [{ closeBrackets: { brackets } }]));
}

/**
 * `{` typed between the empty braces of \cite{} or \ref{} is dropped: they
 * are there already when the command came from the list, and closeBrackets
 * would nest a second pair.
 */
export const keyBraceGuard: Extension = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '{' || from !== to || view.state.selection.ranges.length > 1) return false;
  if (view.state.sliceDoc(to, to + 1) !== '}') return false;
  const before = view.state.sliceDoc(view.state.doc.lineAt(from).from, from);
  return (CITE_RE.exec(before) ?? REF_RE.exec(before))?.[1] === '';
}));

/** `at` 0 is stale: the entries still answer a hover until the refetch has. */
let bibCache: { key: string; entries: BibEntry[]; at: number } | null = null;

/** The cached entries of this project and branch; never another one's. */
function cachedBib(projectId: string, branch: string): BibEntry[] {
  return bibCache?.key === `${projectId}::${branch}` ? bibCache.entries : [];
}

async function loadBib(projectId: string, branch: string): Promise<BibEntry[]> {
  const cacheKey = `${projectId}::${branch}`;
  if (bibCache && bibCache.key === cacheKey && Date.now() - bibCache.at < 15_000) return bibCache.entries;
  try {
    const entries = await api.bib(projectId, branch);
    bibCache = { key: cacheKey, entries, at: Date.now() };
    return entries;
  } catch {
    return cachedBib(projectId, branch);
  }
}

export function invalidateBibCache(): void {
  if (bibCache) bibCache = { ...bibCache, at: 0 };
}

/** Pre-load the bib index so hover tooltips work before the first \cite completion. */
export function warmBib(projectId: string, branch: string): void {
  void loadBib(projectId, branch);
}

function firstAuthor(author?: string): string {
  if (!author) return '';
  const first = author.split(/\s+and\s+/i)[0];
  const lastName = first.includes(',') ? first.split(',')[0] : first.split(' ').pop() || first;
  return author.match(/\band\b/i) ? `${lastName} et al.` : lastName;
}

export function citeCompletionSource(projectId: string, branch: string): CompletionSource {
  return async (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    const m = before.match(CITE_RE);
    if (!m) return null;
    const segment = m[1];
    const lastComma = segment.lastIndexOf(',');
    const q = segment.slice(lastComma + 1).trim().toLowerCase();
    const from = ctx.pos - (segment.length - lastComma - 1);
    const entries = await loadBib(projectId, branch);
    const options: Completion[] = entries
      .map((e) => ({ e, rank: citeRank(e, q) }))
      .filter(({ rank }) => rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 80)
      .map(({ e }) => ({
        label: e.key,
        detail: [byline(e), e.title].filter(Boolean).join(' · '),
        info: e.title,
        type: 'constant',
        apply: applyKeyAndHopBrace,
      }));
    if (!options.length) return null;
    // filter:false — CodeMirror would match the typed text against the key
    // alone and drop every entry found by its author or title
    return { from, options, filter: false };
  };
}

function byline(e: BibEntry): string {
  return [e.authorLabel ? (e.author?.match(/\band\b/i) ? `${e.authorLabel} et al.` : e.authorLabel) : firstAuthor(e.author), e.year].filter(Boolean).join(' ');
}

/** How well an entry answers the query; 0 is no match. Key prefix, key, author, title, year. */
function citeRank(e: BibEntry, q: string): number {
  if (!q) return 1;
  const key = e.key.toLowerCase();
  if (key.startsWith(q)) return 5;
  if (key.includes(q)) return 4;
  if ((e.author || '').toLowerCase().includes(q)) return 3;
  if ((e.title || '').toLowerCase().includes(q)) return 2;
  return (e.year || '').includes(q) ? 1 : 0;
}

let labelCache: { key: string; labels: Array<{ label: string; file: string }>; at: number } | null = null;

async function loadLabels(projectId: string, branch: string): Promise<Array<{ label: string; file: string }>> {
  const cacheKey = `${projectId}::${branch}`;
  if (labelCache && labelCache.key === cacheKey && Date.now() - labelCache.at < 15_000) return labelCache.labels;
  try {
    const labels = await api.labels(projectId, branch);
    labelCache = { key: cacheKey, labels, at: Date.now() };
    return labels;
  } catch {
    return labelCache?.key === cacheKey ? labelCache.labels : [];
  }
}

export function invalidateLabelCache(): void {
  labelCache = null;
}

/** Hover a \cite{key} to see the reference it points to. */
export function citeHoverTooltip(projectId: string, branch: string): Extension {
  return hoverTooltip(citeHoverSource(projectId, branch), { hoverTime: 300 });
}

export function citeHoverSource(projectId: string, branch: string): HoverTooltipSource {
  return (view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const rel = pos - line.from;
    // find a \cite{...} (or variants) spanning the hovered position
    const re = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const braceStart = m.index + m[0].indexOf('{') + 1;
      const braceEnd = m.index + m[0].length - 1;
      if (rel < braceStart || rel > braceEnd) continue;
      // which key is under the cursor (comma-separated)?
      const keys = m[1].split(',');
      let acc = braceStart;
      let key = keys[0];
      for (const k of keys) {
        if (rel >= acc && rel <= acc + k.length) { key = k; break; }
        acc += k.length + 1;
      }
      key = key.trim();
      const from = line.from + braceStart;
      const tooltip = (entry: BibEntry | undefined) => ({
        pos: from,
        end: line.from + braceEnd,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.style.cssText = 'padding:8px 10px;max-width:320px;font-family:var(--font-ui);font-size:12px;line-height:1.5';
          if (entry) {
            const title = document.createElement('div');
            title.style.cssText = 'font-weight:600;margin-bottom:2px';
            title.textContent = entry.title || key;
            const meta = document.createElement('div');
            meta.style.cssText = 'color:var(--text-2)';
            meta.textContent = [entry.author, entry.year, entry.journal].filter(Boolean).join(' · ');
            dom.append(title, meta);
          } else {
            dom.style.color = 'var(--error)';
            dom.textContent = `No bibliography entry for “${key}”`;
          }
          return { dom };
        },
      });
      // A cached entry renders at once while a stale cache refreshes behind
      // it; a key the cache lacks waits for loadBib, so a stale cache never
      // says a key is missing. (loadBib is TTL-guarded, so hovering
      // repeatedly doesn't hammer the server.)
      const loading = loadBib(projectId, branch);
      const cached = bibCache?.key === `${projectId}::${branch}` ? bibCache.entries.find((e) => e.key === key) : undefined;
      if (cached) return tooltip(cached);
      return loading.then((entries) => tooltip(entries.find((e) => e.key === key)));
    }
    return null;
  };
}

export function refCompletionSource(projectId: string, branch: string, currentFile: () => string): CompletionSource {
  return async (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    const m = before.match(REF_RE);
    if (!m) return null;
    const q = m[1].toLowerCase();

    // current-file labels first (instant), then project-wide (cached)
    const local = new Map<string, string>();
    const text = ctx.state.doc.toString();
    const re = /\\label\{([^}]+)\}/g;
    let mm: RegExpExecArray | null;
    const cur = currentFile();
    while ((mm = re.exec(text))) local.set(mm[1], cur);

    const project = await loadLabels(projectId, branch);
    const merged = new Map<string, string>(local);
    for (const { label, file } of project) if (!merged.has(label)) merged.set(label, file);

    const options = Array.from(merged.entries())
      .filter(([l]) => !q || l.toLowerCase().includes(q))
      .slice(0, 100)
      .map(([l, file]) => ({
        label: l,
        detail: file === cur ? undefined : file,
        type: 'variable' as const,
        boost: local.has(l) ? 1 : 0,
        apply: applyKeyAndHopBrace,
      }));
    if (!options.length) return null;
    return { from: ctx.pos - m[1].length, options, validFor: /^[^}]*$/ };
  };
}
