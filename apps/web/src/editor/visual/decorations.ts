import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { RevealRange, intersectsReveal } from './reveal';
import { MathWidget } from './widgets/math';
import { figureChip, tableChip, citeChip, refChip } from './widgets/chips';
import { TableWidget, parseTabular } from './widgets/table';
import { ItemMarkerWidget } from './widgets/listMarker';

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

const hide = Decoration.replace({});
const styleMarks = Object.fromEntries(
  Object.entries(STYLE_CLASS).map(([k, cls]) => [k, Decoration.mark({ class: cls })]),
) as Record<string, Decoration>;
const headingLines = [1, 2, 3, 4].map((n) => Decoration.line({ class: `cm-vis-h cm-vis-h${n}` }));

export interface WalkEmit {
  /** Decoration.replace/widget material + atomic ranges (full-doc StateField). */
  atomic(from: number, to: number, deco: Decoration): void;
  /** Styling marks / line classes (viewport ViewPlugin). */
  mark(from: number, to: number, deco: Decoration): void;
}

/**
 * Extract renderable math from a math node, or null if `name` isn't math or
 * the construct is incomplete. Equation-array content is wrapped in `aligned`
 * so KaTeX can typeset the `&`/`\\` alignment.
 */
function mathParts(name: string, node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): { source: string; display: boolean; innerFrom: number; innerTo: number } | null {
  const slice = (a: number, b: number) => doc.sliceString(a, b).trim();
  if (name === 'DollarMath') {
    const inner = node.getChild('InlineMath') ?? node.getChild('DisplayMath');
    const dollars = node.getChildren('Dollar');
    if (!inner || dollars.length < 2) return null;
    return { source: slice(inner.from, inner.to), display: inner.name === 'DisplayMath', innerFrom: inner.from, innerTo: inner.to };
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

/**
 * Single tree walk over [from,to] emitting visual decorations. Whitelist-only:
 * anything not positively matched (unknown commands, ⚠ errors, unclosed
 * constructs) stays raw source. Verbatim subtrees are never entered. Nodes
 * intersecting a reveal range are skipped (their source shows).
 */
/** First braced-argument interior text of a node (e.g. a caption), trimmed. */
function argText(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string {
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

const itemLine = Decoration.line({ class: 'cm-vis-li' });
const captionMark = Decoration.mark({ class: 'cm-vis-cap' });

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
        // hide the \begin{...}/\end{...} line including one adjacent newline so
        // the list reads as a block; bail out near doc edges or odd layouts.
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
        const caption = findDescendant(n.node, 'Caption');
        const label = caption ? argText(caption, doc) : '';
        let image: string | null = null;
        const ig = findDescendant(n.node, 'IncludeGraphics');
        const igArg = ig && (findDescendant(ig, 'FilePathArgument') ?? findDescendant(ig, 'BareFilePathArgument'));
        if (igArg) {
          const open = igArg.getChild('OpenBrace');
          const close = igArg.getChild('CloseBrace');
          image = open && close ? doc.sliceString(open.to, close.from).trim() : doc.sliceString(igArg.from, igArg.to).trim();
        }
        emit.atomic(n.from, n.to, Decoration.replace({ widget: figureChip(label, n.from, image) }));
        return false;
      }

      if (n.name === 'TabularEnvironment') {
        if (intersectsReveal(reveals, n.from, n.to)) return; // revealed: show raw source
        const begin = n.node.getChild('BeginEnv');
        const end = n.node.getChild('EndEnv');
        if (!begin || !end || end.to !== n.to) return;
        // column spec is the tabular's argument group right after \begin{tabular}
        const argNode = n.node.getChild('TabularArgument') ?? n.node.getChild('TextArgument') ?? n.node.getChild('NonEmptyGroup');
        const bodyFrom = argNode ? argNode.to : begin.to;
        const parsed = parseTabular(doc.sliceString(bodyFrom, end.from), bodyFrom);
        if (!parsed) {
          emit.atomic(n.from, n.to, Decoration.replace({ widget: tableChip('', n.from) }));
          return false;
        }
        const cols = Math.max(...parsed.rows.map((r) => r.length));
        // New rows go above any trailing rule (\bottomrule/\hline) — inserting
        // at the \end{tabular} line puts them below the table's closing rule.
        let insertLine = doc.lineAt(end.from);
        for (let ln = insertLine.number - 1; ln >= 1; ln--) {
          const t = doc.line(ln).text.trim();
          if (!t) continue;
          if (/^(?:\\bottomrule|\\hline)\s*$/.test(t)) insertLine = doc.line(ln);
          break;
        }
        // The spec range comes from the argument node's own bounds, not brace
        // children — findDescendant('CloseBrace') hits the inner brace of
        // @{}-style specs and truncates (or nulls) the range.
        const specOk = argNode
          && doc.sliceString(argNode.from, argNode.from + 1) === '{'
          && doc.sliceString(argNode.to - 1, argNode.to) === '}';
        emit.atomic(n.from, n.to, Decoration.replace({
          widget: new TableWidget({
            rows: parsed.rows,
            rowEnds: parsed.rowEnds,
            cols,
            rowInsertAt: insertLine.from,
            colSpec: specOk ? { from: argNode!.from + 1, to: argNode!.to - 1 } : null,
          }, doc.sliceString(n.from, n.to), n.from),
        }));
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
        emit.atomic(n.from, n.to, Decoration.replace({ widget: n.name === 'Cite' ? citeChip(keys, n.from) : refChip(keys, n.from) }));
        return false;
      }

      const rank = SECTION_RANK[n.name];
      if (rank) {
        const cmd = n.node.getChild('SectioningCommand');
        if (!cmd || intersectsReveal(reveals, cmd.from, cmd.to)) return;
        const parts = wrapperParts(cmd, 'SectioningArgument');
        if (!parts || parts.closeTo !== cmd.to) return;
        emit.atomic(cmd.from, parts.openEnd, hide);
        emit.atomic(parts.closeFrom, parts.closeTo, hide);
        emit.mark(doc.lineAt(cmd.from).from, doc.lineAt(cmd.from).from, headingLines[rank - 1]);
        return; // children of the heading argument render as plain heading text
      }

      const math = mathParts(n.name, n.node, doc);
      if (math) {
        if (intersectsReveal(reveals, n.from, n.to)) return false;
        emit.atomic(n.from, n.to, Decoration.replace({ widget: new MathWidget(math.source, math.display, n.from, math.innerFrom, math.innerTo) }));
        return false; // math interior is the widget's business
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

/** Full-document atomic set (replace decorations). */
export function buildAtomic(state: EditorState, reveals: readonly RevealRange[]): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  walk(state, reveals, 0, state.doc.length, {
    atomic: (from, to, deco) => { if (from < to) ranges.push({ from, to, deco }); },
    mark: () => {},
  });
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
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
