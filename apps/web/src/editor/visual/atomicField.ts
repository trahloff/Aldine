import { ChangeSet, StateField } from '@codemirror/state';
import type { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { revealField, RevealRange, RevealState } from './reveal';
import { CONSTRUCT_NODES, atomicRangesIn, buildAtomic } from './decorations';
import { resourceArrived } from './refresh';

interface AtomicValue { deco: DecorationSet; forReveal: RevealState }

/** Past this share of the document a rebuild is cheaper than chasing regions. */
const FULL_REBUILD_SHARE = 0.5;

/** Grow [from,to] by every construct node in `tree` that contains or touches either end. */
function constructsAt(tree: Tree, from: number, to: number, grow: (a: number, b: number) => void): void {
  for (const pos of from === to ? [from] : [from, to]) {
    for (const side of [-1, 1] as const) {
      for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
        if (CONSTRUCT_NODES.has(n.name)) grow(n.from, n.to);
      }
    }
  }
}

/**
 * The region [from,to] (new-document offsets) that must be walked again so
 * that decorations outside it are still exactly what a full rebuild would
 * make: grown until neither tree has a construct crossing its ends and no
 * existing decoration touches them.
 */
function settleRegion(
  state: EditorState, deco: DecorationSet, from: number, to: number,
  old: { tree: Tree; changes: ChangeSet } | null,
): [number, number] {
  const tree = syntaxTree(state);
  for (;;) {
    let a = from;
    let b = to;
    const grow = (x: number, y: number) => { if (x < a) a = x; if (y > b) b = y; };
    constructsAt(tree, from, to, grow);
    if (old) {
      const back = old.changes.invertedDesc;
      constructsAt(old.tree, back.mapPos(from, -1), back.mapPos(to, 1), (x, y) => grow(old.changes.mapPos(x, -1), old.changes.mapPos(y, 1)));
    }
    deco.between(a, b, (x, y) => grow(x, y));
    if (a === from && b === to) return [a, b];
    from = a;
    to = b;
  }
}

/**
 * Where the new tree differs from the old one, plus the changed text itself.
 * Found from the root down: children that match (same type, same extent once
 * mapped) are paired and compared again inside, unless one is the very
 * subtree the parser reused; a child without a match is changed whole. An
 * unclosed brace that now swallows a table, a `$` that re-pairs every later
 * dollar, an environment name that turns what follows into math, or error
 * recovery that now ends a command elsewhere shows up here although no
 * construct node contains the edit.
 */
function changedSpans(oldTree: Tree, newTree: Tree, changes: ChangeSet): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  changes.iterChangedRanges((_fA, _tA, fB, tB) => { out.push([fB, tB]); });
  const from = (o: SyntaxNode) => changes.mapPos(o.from, -1);
  const to = (o: SyntaxNode) => changes.mapPos(o.to, 1);
  const walk = (n: SyntaxNode, o: SyntaxNode) => {
    if (n.tree && n.tree === o.tree) return;
    let nc = n.firstChild;
    let oc = o.firstChild;
    while (nc || oc) {
      if (nc && oc && nc.name === oc.name && nc.from === from(oc) && nc.to === to(oc)) {
        walk(nc, oc);
        nc = nc.nextSibling;
        oc = oc.nextSibling;
      } else if (nc && (!oc || nc.from <= from(oc))) {
        out.push([nc.from, nc.to]);
        nc = nc.nextSibling;
      } else if (oc) {
        out.push([from(oc), to(oc)]);
        oc = oc.nextSibling;
      }
    }
  };
  walk(newTree.topNode, oldTree.topNode);
  return out;
}

function merge(regions: Array<[number, number]>): Array<[number, number]> {
  regions.sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const r of regions) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function sameRanges(a: readonly RevealRange[], b: readonly RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}

/**
 * Decorations kept from the previous state (mapped through the edit) plus a
 * fresh walk of only the regions an edit, a reveal change or the parser
 * reaching further can affect. The result equals buildAtomic() for the new
 * state; null asks for a full rebuild (the tree was re-parsed in place, or
 * most of the document changed).
 */
function update(value: AtomicValue, tr: Transaction, rv: RevealState): DecorationSet | null {
  const state = tr.state;
  const len = state.doc.length;
  let deco = value.deco;
  const regions: Array<[number, number]> = [];
  const oldTree = syntaxTree(tr.startState);
  const newTree = syntaxTree(state);
  let old: { tree: Tree; changes: ChangeSet } | null = null;
  if (tr.docChanged) {
    deco = deco.map(tr.changes);
    old = { tree: oldTree, changes: tr.changes };
    regions.push(...changedSpans(oldTree, newTree, tr.changes));
  } else if (newTree !== oldTree) {
    // A partial tree ends where parsing stopped; text before that parses the
    // same once the parser goes on, so only what it reached is new.
    if (newTree.length <= oldTree.length) return null;
    old = { tree: oldTree, changes: ChangeSet.empty(len) };
    regions.push([oldTree.length, newTree.length]);
  }
  const before = tr.docChanged
    ? value.forReveal.ranges.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }))
    : value.forReveal.ranges;
  if (!sameRanges(before, rv.ranges)) {
    for (const r of before) regions.push([r.from, r.to]);
    for (const r of rv.ranges) regions.push([r.from, r.to]);
  }
  if (!regions.length) return deco;
  // whole lines: list \begin/\end lines and heading closers depend on what else is on their line
  const doc = state.doc;
  const lines = regions.map(([a, b]): [number, number] => [doc.lineAt(a).from, doc.lineAt(b).to]);
  let settled = merge(lines.map(([a, b]) => settleRegion(state, deco, a, b, old)));
  // settling one region can swallow another; settle again until stable
  for (let changed = true; changed;) {
    changed = false;
    const next = merge(settled.map(([a, b]) => settleRegion(state, deco, a, b, old)));
    if (next.length !== settled.length || next.some((r, i) => r[0] !== settled[i][0] || r[1] !== settled[i][1])) changed = true;
    settled = next;
  }
  if (settled.reduce((n, [a, b]) => n + b - a, 0) > len * FULL_REBUILD_SHARE) return null;
  const add = [];
  for (const [a, b] of settled) {
    for (const r of atomicRangesIn(state, rv.ranges, a, b)) {
      // a construct only touching the region from outside is unchanged and kept
      if (r.to > a && r.from < b) add.push(r);
    }
  }
  for (const [a, b] of settled) {
    deco = deco.update({ filterFrom: a, filterTo: b, filter: (x, y) => !(x >= a && y <= b) });
  }
  return deco.update({ add, sort: true });
}

/**
 * Full-document replace decorations (hidden markup, widgets) plus the matching
 * atomic ranges so the caret skips over hidden spans. Widget DOM stays lazy
 * (CM calls toDOM only for the viewport), and an edit re-walks only the
 * constructs it can reach, so the cost of a keystroke does not grow with the
 * document.
 */
export const atomicField = StateField.define<AtomicValue>({
  create(state) {
    const rv = state.field(revealField);
    return { deco: buildAtomic(state, rv.ranges), forReveal: rv };
  },
  update(value, tr) {
    const rv = tr.state.field(revealField);
    if (tr.effects.some((e) => e.is(resourceArrived))) return { deco: buildAtomic(tr.state, rv.ranges), forReveal: rv };
    if (!tr.docChanged && rv === value.forReveal && syntaxTree(tr.state) === syntaxTree(tr.startState)) return value;
    const deco = update(value, tr, rv) ?? buildAtomic(tr.state, rv.ranges);
    return { deco, forReveal: rv };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});
