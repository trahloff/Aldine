import { EditorState, Range, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { RevealRange, intersectsReveal } from './reveal';
import { MathWidget } from './widgets/math';
import { figureChip, tableChip, citeChip, refChip } from './widgets/chips';
import { TableWidget, tableModel } from './widgets/table';
import { ItemMarkerWidget } from './widgets/listMarker';
import { SymbolWidget } from './widgets/symbol';

/** Copied from codemirror-lang-latex (internal SECTION_RANK, not exported). */
export const SECTION_RANK: Record<string, number> = {
  Book: 1, Part: 1, Chapter: 1,
  Section: 1, SubSection: 2, SubSubSection: 3,
  Paragraph: 4, SubParagraph: 4,
};

const STYLE_CLASS: Record<string, string> = {
  TextBoldCommand: 'cm-vis-b',
  TextItalicCommand: 'cm-vis-i',
  EmphasisCommand: 'cm-vis-i',
  UnderlineCommand: 'cm-vis-u',
  TextSmallCapsCommand: 'cm-vis-sc',
};

const MATH_NODES = ['DollarMath', 'BracketMath', 'ParenMath', 'EquationEnvironment', 'EquationArrayEnvironment'];

/**
 * Every node the walk below decorates, plus the containers whose extent its
 * output depends on (list numbering, verbatim, comments). An edit inside one
 * of these may change decorations anywhere inside it.
 */
export const CONSTRUCT_NODES = new Set([
  'ListEnvironment', 'TableEnvironment', 'BeginEnv', 'EndEnv', 'Item', 'Caption',
  'FigureEnvironment', 'TabularEnvironment', 'Cite', 'Ref', 'SectioningCommand',
  'VerbatimEnvironment', 'Comment', 'UnknownCommand', 'UrlCommand', 'Centering',
  ...MATH_NODES,
  ...Object.keys(STYLE_CLASS),
]);

const hide = Decoration.replace({});
/** The closing brace of a heading that ends its line: End and clicks past the
 *  heading land before it, inside the heading (the filter in index.ts). */
export const hideHeadingCloser = Decoration.replace({ headingCloser: true });
/** A \begin/\end line of a list, hidden whole so the items keep their own lines. */
const hideLine = Decoration.replace({ block: true });
const styleMarks = Object.fromEntries(
  Object.entries(STYLE_CLASS).map(([k, cls]) => [k, Decoration.mark({ class: cls })]),
) as Record<string, Decoration>;
const headingLines = [1, 2, 3, 4].map((n) => Decoration.line({ class: `cm-vis-h cm-vis-h${n}` }));
/** A heading sharing its line with body text (\paragraph{Para} text): only the argument is styled. */
const headingRun = Decoration.mark({ class: 'cm-vis-hrun' });
const urlMark = Decoration.mark({ class: 'cm-vis-url' });

/** Escapes that typeset as one character: `\%` → %. `\\` and `\ ` are not among them. */
const CTRL_SYMBOLS: Record<string, string> = {
  '\\%': '%', '\\&': '&', '\\$': '$', '\\#': '#', '\\_': '_', '\\{': '{', '\\}': '}',
};
/** Control words that typeset as one character, written bare or with an empty `{}`. */
const CTRL_WORDS: Record<string, string> = {
  '\\ldots': '…', '\\dots': '…', '\\textellipsis': '…',
  '\\textasciitilde': '~', '\\textasciicircum': '^', '\\textbackslash': '\\',
};
const symbolWidgets = new Map<string, Decoration>();
function symbol(text: string): Decoration {
  let d = symbolWidgets.get(text);
  if (!d) symbolWidgets.set(text, d = Decoration.replace({ widget: new SymbolWidget(text) }));
  return d;
}

/** The span of an escape that typesets as one character, and that character; null for anything else. */
export function symbolEscape(node: SyntaxNode, doc: Doc): { from: number; to: number; text: string } | null {
  const sym = node.getChild('CtrlSym');
  if (sym) {
    const text = CTRL_SYMBOLS[doc.sliceString(sym.from, sym.to)];
    return text ? { from: sym.from, to: sym.to, text } : null;
  }
  const seq = node.getChild('CtrlSeq');
  const text = seq && CTRL_WORDS[doc.sliceString(seq.from, seq.to)];
  if (!seq || !text) return null;
  const arg = node.getChild('TextArgument');
  if (!arg) return { from: seq.from, to: seq.to, text };
  // only an empty {} belongs to the escape; an argument with text is something else
  if (arg.from !== seq.to || doc.sliceString(arg.from, arg.to) !== '{}') return null;
  return { from: seq.from, to: arg.to, text };
}

const LABELS_ONLY = /^(?:\s*\\label\s*\{[^{}]*\})*\s*$/;

/** Whether `rest` after a heading's `}` holds only \label{…}s and spaces, hidden with the brace. */
export function labelsOnlyTail(rest: string): boolean {
  return LABELS_ONLY.test(rest);
}
/**
 * Whether `rest`, the text after a heading's `}` up to the end of its line,
 * still leaves the heading on a line of its own: whitespace, a \label{…} and
 * a comment are not body text.
 */
export function headingLineTail(rest: string): boolean {
  return /^\s*(?:\\label\s*\{[^{}]*\}\s*)*(?:%.*)?$/.test(rest);
}

export interface WalkEmit {
  /** Decoration.replace/widget material + atomic ranges (full-doc StateField). */
  atomic(from: number, to: number, deco: Decoration): void;
  /** Styling marks / line classes (viewport ViewPlugin). */
  mark(from: number, to: number, deco: Decoration): void;
}

type Doc = { sliceString(from: number, to: number): string };

/**
 * Extract renderable math from a math node, or null if `name` isn't math or
 * the construct is incomplete. Equation-array content is wrapped in `aligned`
 * so KaTeX can typeset the `&`/`\\` alignment. `innerFrom`/`innerTo` bound
 * the formula exactly as written, which is what the formula editor edits.
 */
export function mathParts(name: string, node: SyntaxNode, doc: Doc): { source: string; display: boolean; innerFrom: number; innerTo: number } | null {
  const slice = (a: number, b: number) => doc.sliceString(a, b).trim();
  if (name === 'DollarMath') {
    if (node.getChildren('Dollar').length < 2) return null;
    const inline = node.getChild('InlineMath');
    // $$…$$ nests: DollarMath[$, DisplayMath[$, Math, $], $]
    const display = node.getChild('DisplayMath');
    const inner = inline ?? (display && display.getChildren('Dollar').length === 2 ? display.getChild('Math') : null);
    if (!inner) return null;
    return { source: slice(inner.from, inner.to), display: !inline, innerFrom: inner.from, innerTo: inner.to };
  }
  if (name === 'BracketMath' || name === 'ParenMath') {
    const open = node.getChild(name === 'BracketMath' ? 'OpenBracketMath' : 'OpenParenMath');
    const close = node.getChild(name === 'BracketMath' ? 'CloseBracketMath' : 'CloseParenMath');
    if (!open || !close) return null;
    return { source: slice(open.to, close.from), display: name === 'BracketMath', innerFrom: open.to, innerTo: close.from };
  }
  if (name === 'EquationEnvironment' || name === 'EquationArrayEnvironment') {
    const begin = node.getChild('BeginEnv');
    const end = node.getChild('EndEnv');
    if (!begin || !end || end.to !== node.to) return null;
    const body = slice(begin.to, end.from);
    return {
      source: name === 'EquationArrayEnvironment' ? `\\begin{aligned}${body}\\end{aligned}` : body,
      display: true,
      innerFrom: begin.to,
      innerTo: end.from,
    };
  }
  return null;
}

/**
 * The argument interior of a `\cmd{...}` wrapper: returns the hide ranges for
 * `\cmd{` and `}` plus the interior span — or null when the construct is
 * incomplete (unclosed brace ⇒ leave as raw source).
 */
function wrapperParts(node: SyntaxNode, argName: string) {
  const arg = node.getChild(argName);
  const open = arg?.getChild('OpenBrace');
  const close = arg?.getChild('CloseBrace');
  if (!arg || !open || !close || close.to !== node.to) return null;
  return { openEnd: open.to, closeFrom: close.from, closeTo: close.to };
}

/** First braced-argument interior text of a node (e.g. a caption), trimmed. */
function argText(node: SyntaxNode, doc: Doc): string {
  const arg = node.getChild('TextArgument') ?? node.getChild('ShortTextArgument');
  const open = arg?.getChild('OpenBrace');
  const close = arg?.getChild('CloseBrace');
  if (!arg || !open || !close) return '';
  return doc.sliceString(open.to, close.from).trim().slice(0, 60);
}

function findDescendant(node: SyntaxNode, name: string): SyntaxNode | null {
  const c = node.cursor();
  do {
    if (c.name === name) return c.node;
  } while (c.next() && c.from < node.to);
  return null;
}

/** First `name` descendant that belongs to `node` itself, not to a nested `skip` (a subfigure's caption). */
function ownDescendant(node: SyntaxNode, name: string, skip: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) return c;
    if (c.name === skip) continue;
    const hit = ownDescendant(c, name, skip);
    if (hit) return hit;
  }
  return null;
}

const itemLine = Decoration.line({ class: 'cm-vis-li' });
const captionMark = Decoration.mark({ class: 'cm-vis-cap' });

/**
 * Single tree walk over [from,to] emitting visual decorations. Whitelist-only:
 * anything not positively matched (unknown commands, ⚠ errors, unclosed
 * constructs) stays raw source. Verbatim subtrees are never entered. Nodes
 * intersecting a reveal range are skipped (their source shows).
 */
export function walk(state: EditorState, reveals: readonly RevealRange[], from: number, to: number, emit: WalkEmit): void {
  const doc = state.doc;
  // enumerate counters per list nesting depth
  const listStack: Array<{ name: string; counter: number }> = [];
  syntaxTree(state).iterate({
    from,
    to,
    leave(n) {
      if (n.name === 'ListEnvironment' || n.name === 'TableEnvironment') listStack.pop();
    },
    enter(n) {
      if (n.name === 'VerbatimEnvironment') return false;
      if (n.name === 'Comment') return false;

      if (n.name === 'ListEnvironment' || n.name === 'TableEnvironment') {
        const envName = findDescendant(n.node, n.name === 'ListEnvironment' ? 'ListEnvName' : 'TableEnvName');
        listStack.push({ name: envName ? doc.sliceString(envName.from, envName.to) : 'itemize', counter: 0 });
        return; // walk into items / tabular / caption
      }
      if (n.name === 'BeginEnv' || n.name === 'EndEnv') {
        const inList = listStack.length > 0;
        if (!inList || intersectsReveal(reveals, n.from, n.to)) return;
        const line = doc.lineAt(n.from);
        if (n.to <= line.to && !doc.sliceString(line.from, n.from).trim() && !doc.sliceString(n.to, line.to).trim()) {
          emit.atomic(line.from, line.to, hideLine);
          return;
        }
        // \begin{...}/\end{...} sharing its line with content: hide it with one
        // adjacent newline so the list still reads as a block
        let hideFrom = n.from;
        let hideTo = n.to;
        if (n.name === 'BeginEnv' && hideTo < doc.length && doc.sliceString(hideTo, hideTo + 1) === '\n') hideTo += 1;
        else if (n.name === 'EndEnv' && hideFrom > 0 && doc.sliceString(hideFrom - 1, hideFrom) === '\n') hideFrom -= 1;
        emit.atomic(hideFrom, hideTo, hide);
        return;
      }
      if (n.name === 'Item') {
        const top = listStack[listStack.length - 1];
        const tok = n.node.getChild('ItemCtrlSeq');
        if (!top || !tok || !['itemize', 'enumerate', 'description'].includes(top.name)) return;
        if (intersectsReveal(reveals, tok.from, tok.to)) return;
        let markerTo = tok.to;
        if (doc.sliceString(markerTo, markerTo + 1) === ' ') markerTo += 1;
        const marker = top.name === 'enumerate' ? `${++top.counter}. ` : top.name === 'description' ? '– ' : '•  ';
        emit.atomic(tok.from, markerTo, Decoration.replace({ widget: new ItemMarkerWidget(marker) }));
        emit.mark(doc.lineAt(tok.from).from, doc.lineAt(tok.from).from, itemLine);
        return;
      }

      if (n.name === 'Caption') {
        if (intersectsReveal(reveals, n.from, n.to)) return;
        const parts = wrapperParts(n.node, 'TextArgument');
        if (!parts) return;
        emit.atomic(n.from, parts.openEnd, hide);
        emit.atomic(parts.closeFrom, parts.closeTo, hide);
        if (parts.openEnd < parts.closeFrom) emit.mark(parts.openEnd, parts.closeFrom, captionMark);
        return;
      }

      if (n.name === 'FigureEnvironment') {
        if (intersectsReveal(reveals, n.from, n.to)) return; // revealed: show raw source
        const end = n.node.getChild('EndEnv');
        if (!end || end.to !== n.to) return; // incomplete env stays raw
        const caption = ownDescendant(n.node, 'Caption', 'FigureEnvironment') ?? findDescendant(n.node, 'Caption');
        const label = caption ? argText(caption, doc) : '';
        let image: string | null = null;
        const ig = findDescendant(n.node, 'IncludeGraphics');
        const igArg = ig && (findDescendant(ig, 'FilePathArgument') ?? findDescendant(ig, 'BareFilePathArgument'));
        if (igArg) {
          const open = igArg.getChild('OpenBrace');
          const close = igArg.getChild('CloseBrace');
          image = open && close ? doc.sliceString(open.to, close.from).trim() : doc.sliceString(igArg.from, igArg.to).trim();
        }
        emit.atomic(n.from, n.to, Decoration.replace({ widget: figureChip(label, image) }));
        return false;
      }

      if (n.name === 'TabularEnvironment') {
        if (intersectsReveal(reveals, n.from, n.to)) return; // revealed: show raw source
        const begin = n.node.getChild('BeginEnv');
        const end = n.node.getChild('EndEnv');
        if (!begin || !end || end.to !== n.to) return;
        const model = tableModel(doc, n.node);
        const source = doc.sliceString(n.from, n.to);
        emit.atomic(n.from, n.to, Decoration.replace({ widget: model ? new TableWidget(model, source) : tableChip('') }));
        return false;
      }

      if (n.name === 'Cite' || n.name === 'Ref') {
        if (intersectsReveal(reveals, n.from, n.to)) return;
        const argName = n.name === 'Cite' ? 'BibKeyArgument' : 'RefArgument';
        const arg = n.node.getChild(argName);
        const inner = arg?.getChild('ShortTextArgument') ?? arg;
        const open = inner?.getChild('OpenBrace');
        const close = inner?.getChild('CloseBrace');
        if (!inner || !open || !close || close.to !== n.to) return;
        const keys = doc.sliceString(open.to, close.from).trim();
        if (n.name === 'Cite') {
          const notes = n.node.getChildren('OptionalArgument').map((o) => doc.sliceString(o.from + 1, o.to - 1));
          emit.atomic(n.from, n.to, Decoration.replace({ widget: citeChip(keys, notes) }));
        } else {
          emit.atomic(n.from, n.to, Decoration.replace({ widget: refChip(keys) }));
        }
        return false;
      }

      const rank = SECTION_RANK[n.name];
      if (rank) {
        const cmd = n.node.getChild('SectioningCommand');
        if (!cmd || intersectsReveal(reveals, cmd.from, cmd.to)) return;
        const parts = wrapperParts(cmd, 'SectioningArgument');
        if (!parts || parts.closeTo !== cmd.to) return;
        const line = doc.lineAt(cmd.from);
        const rest = doc.sliceString(parts.closeTo, line.to);
        const ownLine = !doc.sliceString(line.from, cmd.from).trim() && headingLineTail(rest);
        emit.atomic(cmd.from, parts.openEnd, hide);
        if (ownLine && labelsOnlyTail(rest)) emit.atomic(parts.closeFrom, line.to, hideHeadingCloser);
        else emit.atomic(parts.closeFrom, parts.closeTo, hide);
        if (ownLine) emit.mark(line.from, line.from, headingLines[rank - 1]);
        else if (parts.openEnd < parts.closeFrom) emit.mark(parts.openEnd, parts.closeFrom, headingRun);
        return; // children of the heading argument render as plain heading text
      }

      const math = mathParts(n.name, n.node, doc);
      if (math) {
        if (intersectsReveal(reveals, n.from, n.to)) return false;
        const widget = new MathWidget(math.source, math.display, doc.sliceString(n.from, n.to), math.innerFrom - n.from, math.innerTo - n.from);
        emit.atomic(n.from, n.to, Decoration.replace({ widget }));
        return false; // math interior is the widget's business
      }

      if (n.name === 'UnknownCommand') {
        const esc = symbolEscape(n.node, doc);
        if (!esc) return; // an unknown macro's arguments may hold constructs of their own
        if (!intersectsReveal(reveals, esc.from, esc.to)) emit.atomic(esc.from, esc.to, symbol(esc.text));
        return false;
      }

      if (n.name === 'UrlCommand') {
        if (intersectsReveal(reveals, n.from, n.to)) return false;
        const arg = n.node.getChild('UrlArgument');
        const open = arg?.getChild('OpenBrace');
        const close = arg?.getChild('CloseBrace');
        if (!arg || !open || !close || close.to !== n.to || open.to >= close.from) return false;
        emit.atomic(n.from, open.to, hide);
        emit.atomic(close.from, close.to, hide);
        emit.mark(open.to, close.from, urlMark);
        return false;
      }

      if (n.name === 'Centering') {
        if (intersectsReveal(reveals, n.from, n.to)) return false;
        const line = doc.lineAt(n.from);
        if (!doc.sliceString(line.from, n.from).trim() && !doc.sliceString(n.to, line.to).trim()) {
          emit.atomic(line.from, line.to, hideLine);
        } else {
          let to = n.to;
          while (to < line.to && /[ \t]/.test(doc.sliceString(to, to + 1))) to++;
          emit.atomic(n.from, to, hide);
        }
        return false;
      }

      const styleMark = styleMarks[n.name];
      if (styleMark) {
        if (intersectsReveal(reveals, n.from, n.to)) return;
        const parts = wrapperParts(n.node, 'TextArgument');
        if (!parts) return;
        emit.atomic(n.from, parts.openEnd, hide);
        emit.atomic(parts.closeFrom, parts.closeTo, hide);
        if (parts.openEnd < parts.closeFrom) emit.mark(parts.openEnd, parts.closeFrom, styleMark);
        return; // interior may nest further styles; walk continues into it
      }
    },
  });
}

/** Atomic (replace) decorations for [from,to] as ranges, unsorted. */
export function atomicRangesIn(state: EditorState, reveals: readonly RevealRange[], from: number, to: number): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  walk(state, reveals, from, to, {
    atomic: (a, b, deco) => { if (a < b) ranges.push(deco.range(a, b)); },
    mark: () => {},
  });
  return ranges;
}

/** Full-document atomic set (replace decorations). */
export function buildAtomic(state: EditorState, reveals: readonly RevealRange[]): DecorationSet {
  return Decoration.set(atomicRangesIn(state, reveals, 0, state.doc.length), true);
}

/** Viewport mark/line set for the given visible ranges. */
export function buildMarks(state: EditorState, reveals: readonly RevealRange[], visible: readonly { from: number; to: number }[]): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  for (const v of visible) {
    walk(state, reveals, v.from, v.to, {
      atomic: () => {},
      mark: (from, to, deco) => ranges.push({ from, to, deco }),
    });
  }
  // line decorations are zero-length at line start and must precede marks there
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  let prev: { from: number; to: number } | null = null;
  for (const r of ranges) {
    if (prev && prev.from === r.from && prev.to === r.to) continue; // dedupe overlapping viewport chunks
    b.add(r.from, r.to, r.deco);
    prev = r;
  }
  return b.finish();
}

export { WidgetType };
