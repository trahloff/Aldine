import { EditorState, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';

export interface RevealRange { from: number; to: number }

/**
 * Constructs Visual draws as one widget (a chip, a formula, a table grid).
 * Their source shows only while a caret or an end of a selection is strictly
 * inside one; at its edges, and covered whole by a selection, it stays drawn
 * and moves, selects and deletes as one unit.
 */
export const CLOSED_UNITS = new Set([
  'Cite', 'Ref',
  'DollarMath', 'BracketMath', 'ParenMath', 'EquationEnvironment', 'EquationArrayEnvironment',
  'FigureEnvironment', 'TabularEnvironment',
]);

/**
 * Node names that form "reveal units": the construct shows raw source instead
 * of its rendering while the local caret is in or touches it, or an end of a
 * selection is strictly inside it (a closed unit only from strictly inside).
 * Innermost unit wins so e.g. bold inside a heading reveals only the bold.
 */
const UNIT_NAMES = new Set([
  'SectioningCommand',
  'TextBoldCommand', 'TextItalicCommand', 'EmphasisCommand', 'UnderlineCommand', 'TextSmallCapsCommand',
  ...CLOSED_UNITS,
  'BeginEnv', 'EndEnv', 'Caption', 'UrlCommand', 'Centering',
]);
// \item reveals only its marker token, and only from strictly inside it.
const ITEM = 'Item';

type Doc = { sliceString(from: number, to: number): string };

/** Where the `\item ` marker Visual hides ends: after the token and one space that follows it. */
export function itemMarkerEnd(doc: Doc, tok: { to: number }): number {
  return doc.sliceString(tok.to, tok.to + 1) === ' ' ? tok.to + 1 : tok.to;
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

/**
 * The unit a caret (`caret`) or a selection end at `pos` reveals, climbing
 * from `node`. A closed unit `pos` is not strictly inside hides everything in
 * it, so the climb goes on above it.
 */
function unitAt(doc: Doc, node: SyntaxNode, pos: number, caret: boolean): RevealRange | null {
  let found: RevealRange | null = null;
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    const inside = n.from < pos && pos < n.to;
    if (CLOSED_UNITS.has(n.name) && !inside) {
      found = null;
      continue;
    }
    if (found) continue;
    if (n.name === ITEM) {
      const tok = n.getChild('ItemCtrlSeq');
      if (tok && tok.from < pos && pos < itemMarkerEnd(doc, tok)) found = { from: tok.from, to: tok.to };
    } else if (UNIT_NAMES.has(n.name) && (caret || inside)) {
      found = { from: n.from, to: n.to };
    }
  }
  return found;
}

/** Whether `node` lies in a closed unit (itself included) that `pos` is not strictly inside. */
function outsideClosed(node: SyntaxNode, pos: number): boolean {
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (CLOSED_UNITS.has(n.name) && !(n.from < pos && pos < n.to)) return true;
  }
  return false;
}

/** The heading whose `}` and same-line \label Visual hides as one, when `pos` is strictly inside that hidden tail. */
function headingTailAt(state: EditorState, tree: Tree, pos: number): RevealRange | null {
  const line = state.doc.lineAt(pos);
  if (pos >= line.to || !line.text.includes('\\label')) return null;
  let hit: RevealRange | null = null;
  tree.iterate({
    from: line.from,
    to: pos,
    enter(n) {
      if (hit) return false;
      if (n.name !== 'SectioningCommand') return;
      const close = n.node.getChild('SectioningArgument')?.getChild('CloseBrace');
      if (close && close.to === n.to && n.from >= line.from && n.to <= line.to && close.from < pos
        && !state.doc.sliceString(line.from, n.from).trim() && labelsOnlyTail(state.doc.sliceString(n.to, line.to))) {
        hit = { from: n.from, to: n.to };
      }
      return false;
    },
  });
  return hit;
}

function pushUnique(out: RevealRange[], r: RevealRange | null) {
  if (r && !out.some((o) => o.from === r.from && o.to === r.to)) out.push(r);
}

function revealAt(state: EditorState, tree: Tree, pos: number, caret: boolean, out: RevealRange[]) {
  for (const side of [-1, 1] as const) pushUnique(out, unitAt(state.doc, tree.resolveInner(pos, side), pos, caret));
  pushUnique(out, headingTailAt(state, tree, pos));
  if (!caret) return;
  // A list's \begin/\end line is hidden whole, indentation included: a
  // caret in that indentation is on the hidden line.
  const line = state.doc.lineAt(pos);
  const start = line.from + (line.text.length - line.text.trimStart().length);
  const end = line.to - (line.text.length - line.text.trimEnd().length);
  if (start > end || (start === line.from && end === line.to) || (pos > start && pos < end)) return;
  for (let n: SyntaxNode | null = tree.resolveInner(start, 1); n && n.from === start; n = n.parent) {
    if ((n.name === 'BeginEnv' || n.name === 'EndEnv' || n.name === 'Centering') && n.to === end && !outsideClosed(n, pos)) {
      pushUnique(out, { from: n.from, to: n.to });
    }
  }
}

/**
 * What the local selection reveals: for a caret, the construct it is in or
 * touches; for a selection, the constructs an end of it is strictly inside.
 * A construct a selection covers whole stays drawn, its source hidden in the
 * selection. Sorted by `from`; nested ranges are kept apart, so a closed unit
 * can tell a caret inside it from an enclosing construct that is revealed.
 */
export function computeRevealRanges(state: EditorState): RevealRange[] {
  const tree = syntaxTree(state);
  const out: RevealRange[] = [];
  for (const r of state.selection.ranges) {
    revealAt(state, tree, r.head, r.empty, out);
    if (!r.empty) revealAt(state, tree, r.anchor, false, out);
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

function sameRanges(a: RevealRange[], b: RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}

export interface RevealState { ranges: RevealRange[] }

/**
 * Reveal ranges, recomputed on selection and doc changes. Only the local
 * selection reveals: a collaborator's caret in a construct outlines it
 * instead (remoteCarets.ts). Returns the previous object when nothing
 * changed, so consumers can gate expensive rebuilds on object identity.
 */
export const revealField = StateField.define<RevealState>({
  create(state) {
    return { ranges: computeRevealRanges(state) };
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const ranges = computeRevealRanges(tr.state);
    if (!tr.docChanged && sameRanges(ranges, value.ranges)) return value;
    return { ranges };
  },
});

export function intersectsReveal(reveals: readonly RevealRange[], from: number, to: number): boolean {
  for (const r of reveals) {
    if (r.from >= to) break;
    if (r.to > from) return true;
  }
  return false;
}

/** Whether a reveal range lies within [from,to]: a caret or a selection end is inside that construct, not only in one around it. */
export function revealsWithin(reveals: readonly RevealRange[], from: number, to: number): boolean {
  for (const r of reveals) {
    if (r.from >= to) break;
    if (r.from >= from && r.to <= to) return true;
  }
  return false;
}
