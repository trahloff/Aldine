import { Completion, CompletionSource, pickedCompletion, startCompletion } from '@codemirror/autocomplete';
import { Extension, Prec } from '@codemirror/state';
import { hoverTooltip, EditorView } from '@codemirror/view';
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
 * Accepting a command that takes a citation key or a label inserts its
 * braces too and lists the keys at once. Renaming the command of an
 * existing citation (`\ci|{key}`, `\ci|[p.~3]{key}`) inserts the name alone.
 */
function applyKeyCommand(view: EditorView, completion: Completion, from: number, to: number): void {
  const bare = /^[{[*]/.test(view.state.sliceDoc(to, to + 1));
  view.dispatch({
    changes: { from, to, insert: bare ? completion.label : `${completion.label}{}` },
    selection: { anchor: from + completion.label.length + (bare ? 0 : 1) },
    annotations: pickedCompletion.of(completion),
    userEvent: 'input.complete',
  });
  if (!bare) startCompletion(view);
}

const keyCommandOptions: Completion[] = [...KEY_COMMANDS].map((label) => ({ label, type: 'function', boost: 1, apply: applyKeyCommand }));

export const keyCommandCompletionSource: CompletionSource = (ctx) => {
  const word = ctx.matchBefore(/\\[a-zA-Z]*$/);
  return word ? { from: word.from, options: keyCommandOptions, validFor: /^\\[a-zA-Z]*$/ } : null;
};

/** codemirror-lang-latex's completions without its \cite and \ref entries, which insert the bare name. */
export function withoutKeyCommands(source: CompletionSource): CompletionSource {
  return async (ctx) => {
    const result = await source(ctx);
    return result && { ...result, options: result.options.filter((o) => !KEY_COMMANDS.has(o.label)) };
  };
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

let bibCache: { key: string; entries: BibEntry[]; at: number } | null = null;

async function loadBib(projectId: string, branch: string): Promise<BibEntry[]> {
  const cacheKey = `${projectId}::${branch}`;
  if (bibCache && bibCache.key === cacheKey && Date.now() - bibCache.at < 15_000) return bibCache.entries;
  try {
    const entries = await api.bib(projectId, branch);
    bibCache = { key: cacheKey, entries, at: Date.now() };
    return entries;
  } catch {
    return bibCache?.entries || [];
  }
}

export function invalidateBibCache(): void {
  bibCache = null;
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
      .filter((e) =>
        !q ||
        e.key.toLowerCase().includes(q) ||
        (e.author || '').toLowerCase().includes(q) ||
        (e.title || '').toLowerCase().includes(q) ||
        (e.year || '').includes(q))
      .slice(0, 80)
      .map((e) => ({
        label: e.key,
        detail: [e.authorLabel ? (e.author?.match(/\band\b/i) ? `${e.authorLabel} et al.` : e.authorLabel) : firstAuthor(e.author), e.year].filter(Boolean).join(' '),
        info: e.title,
        type: 'constant',
        boost: e.key.toLowerCase().startsWith(q) ? 2 : 0,
        apply: applyKeyAndHopBrace,
      }));
    if (!options.length) return null;
    return { from, options, validFor: /^[^,}]*$/ };
  };
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
    return labelCache?.labels || [];
  }
}

export function invalidateLabelCache(): void {
  labelCache = null;
}

/** Hover a \cite{key} to see the reference it points to. */
export function citeHoverTooltip(projectId: string, branch: string): Extension {
  return hoverTooltip((view, pos) => {
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
      // Render from whatever is cached, but kick off a refresh when the entry
      // is stale/missing — the next hover then has current data. (loadBib is
      // TTL-guarded, so hovering repeatedly doesn't hammer the server.)
      void loadBib(projectId, branch);
      const entry = (bibCache?.entries || []).find((e) => e.key === key);
      const from = line.from + braceStart;
      return {
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
      };
    }
    return null;
  }, { hoverTime: 300 });
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
