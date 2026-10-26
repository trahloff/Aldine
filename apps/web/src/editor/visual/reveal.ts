import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

export interface RevealRange { from: number; to: number }

/**
 * Node names that form "reveal units": when any caret (local or remote) sits
 * inside one, that construct shows raw source instead of its rendering.
 * Innermost unit wins so e.g. bold inside a heading reveals only the bold.
 */
const UNIT_NAMES = new Set([
  'SectioningCommand',
  'TextBoldCommand', 'TextItalicCommand', 'EmphasisCommand', 'UnderlineCommand', 'TextSmallCapsCommand',
  'DollarMath', 'BracketMath', 'ParenMath', 'EquationEnvironment', 'EquationArrayEnvironment',
  'FigureEnvironment', 'TableEnvironment', 'TabularEnvironment',
  'Cite', 'Ref', 'BeginEnv', 'EndEnv', 'Caption', 'UrlCommand', 'Centering',
]);
// \item reveals only its marker token, not the item's whole content.
const ITEM = 'Item';

/** Remote collaborators' caret offsets (already mapped to this doc). */
export const setRemoteCarets = StateEffect.define<number[]>();

function unitFor(node: SyntaxNode): RevealRange | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.name === ITEM) {
      const tok = n.getChild('ItemCtrlSeq');
      if (tok) return { from: tok.from, to: tok.to };
    }
    if (UNIT_NAMES.has(n.name)) return { from: n.from, to: n.to };
    n = n.parent;
  }
  return null;
}

function pushUnique(out: RevealRange[], r: RevealRange | null) {
  if (r && !out.some((o) => o.from === r.from && o.to === r.to)) out.push(r);
}

export function computeRevealRanges(state: EditorState, remote: readonly number[]): RevealRange[] {
  const tree = syntaxTree(state);
  const out: RevealRange[] = [];
  const atPos = (pos: number) => {
    for (const side of [-1, 1] as const) pushUnique(out, unitFor(tree.resolveInner(pos, side)));
    // A list's \begin/\end line is hidden whole, indentation included: a
    // caret in that indentation is on the hidden line.
    const line = state.doc.lineAt(pos);
    const start = line.from + (line.text.length - line.text.trimStart().length);
    const end = line.to - (line.text.length - line.text.trimEnd().length);
    if (start > end || (start === line.from && end === line.to) || (pos > start && pos < end)) return;
    for (let n: SyntaxNode | null = tree.resolveInner(start, 1); n && n.from === start; n = n.parent) {
      if ((n.name === 'BeginEnv' || n.name === 'EndEnv' || n.name === 'Centering') && n.to === end) pushUnique(out, { from: n.from, to: n.to });
    }
  };
  for (const r of state.selection.ranges) {
    atPos(r.head);
    if (!r.empty) {
      atPos(r.anchor);
      // A selection must never contain invisible bytes: reveal every unit it touches.
      tree.iterate({
        from: r.from,
        to: r.to,
        enter(n) {
          if (UNIT_NAMES.has(n.name)) pushUnique(out, { from: n.from, to: n.to });
          if (n.name === 'VerbatimEnvironment') return false;
        },
      });
    }
  }
  for (const pos of remote) {
    if (pos >= 0 && pos <= state.doc.length) atPos(pos);
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  // merge overlaps so downstream intersection checks are cheap
  const merged: RevealRange[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

function sameRanges(a: RevealRange[], b: RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}

export interface RevealState { ranges: RevealRange[]; remote: number[] }

/**
 * Reveal ranges, recomputed on selection/doc changes and remote-caret updates.
 * Returns the previous object when nothing changed, so consumers can gate
 * expensive rebuilds on object identity.
 */
export const revealField = StateField.define<RevealState>({
  create(state) {
    return { ranges: computeRevealRanges(state, []), remote: [] };
  },
  update(value, tr) {
    let remote = value.remote;
    for (const e of tr.effects) if (e.is(setRemoteCarets)) remote = e.value;
    const remoteChanged = remote !== value.remote;
    if (!tr.docChanged && !tr.selection && !remoteChanged) return value;
    if (tr.docChanged && !remoteChanged) remote = remote.map((p) => tr.changes.mapPos(p));
    const ranges = computeRevealRanges(tr.state, remote);
    if (!remoteChanged && !tr.docChanged && sameRanges(ranges, value.ranges)) return value;
    return { ranges, remote };
  },
});

export function intersectsReveal(reveals: readonly RevealRange[], from: number, to: number): boolean {
  for (const r of reveals) {
    if (r.from >= to) break;
    if (r.to > from) return true;
  }
  return false;
}
