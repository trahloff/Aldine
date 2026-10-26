import { ChangeSet, Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { revealField, RevealRange, RevealState } from './reveal';
import { CONSTRUCT_NODES, atomicRangesIn, buildAtomic } from './decorations';
import { resourceArrived } from './refresh';
import { macrosOf } from './macros';

/**
 * `pending`: regions whose decorations may not be what a full build makes
 * yet (none drawn, or drawn before a resource arrived). Everywhere else the
 * set equals buildAtomic(). Empty on all but long documents.
 */
interface AtomicValue { deco: DecorationSet; forReveal: RevealState; pending: Array<[number, number]> }

/** A document shorter than `min` is built whole at once; a longer one `chunk` characters at a time. */
export const atomicChunking = Facet.define<{ min: number; chunk: number }, { min: number; chunk: number }>({
  combine: (values) => values[0] ?? { min: 60_000, chunk: 12_000 },
});

/** Builds pending decorations, those meeting `near` (the viewport) first. */
export const buildPending = StateEffect.define<{ from: number; to: number } | null>();

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
function update(value: AtomicValue, tr: Transaction, rv: RevealState): { deco: DecorationSet; settled: Array<[number, number]> } | null {
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
  if (!regions.length) return { deco, settled: [] };
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
  return { deco: replaceIn(deco, settled, add), settled };
}

/** `deco` with everything inside `regions` swapped for `add`. */
function replaceIn(deco: DecorationSet, regions: Array<[number, number]>, add: ReturnType<typeof atomicRangesIn>): DecorationSet {
  for (const [a, b] of regions) {
    deco = deco.update({ filterFrom: a, filterTo: b, filter: (x, y) => !(x >= a && y <= b) });
  }
  return deco.update({ add, sort: true });
}

/** [from,to] grown to whole lines and settled, walked, and put in place of what `deco` has there. */
function walkRegion(state: EditorState, rv: RevealState, deco: DecorationSet, from: number, to: number): { deco: DecorationSet; region: [number, number] } {
  const doc = state.doc;
  const [a, b] = settleRegion(state, deco, doc.lineAt(from).from, doc.lineAt(to).to, null);
  const add = atomicRangesIn(state, rv.ranges, a, b).filter((r) => r.to > a && r.from < b);
  return { deco: replaceIn(deco, [[a, b]], add), region: [a, b] };
}

function subtract(pending: Array<[number, number]>, done: Array<[number, number]>): Array<[number, number]> {
  let out = pending;
  for (const [a, b] of done) {
    const next: Array<[number, number]> = [];
    for (const [x, y] of out) {
      if (b <= x || a >= y) { next.push([x, y]); continue; }
      if (x < a) next.push([x, a]);
      if (b < y) next.push([b, y]);
    }
    out = next;
  }
  return out;
}

/**
 * The whole document, or on a long one only a chunk around `near` (the
 * viewport, else the caret), the rest left pending for idle time. `keep`
 * stays shown meanwhile where it is not rebuilt yet.
 */
function build(state: EditorState, rv: RevealState, keep: DecorationSet | null, near: { from: number; to: number } | null): AtomicValue {
  const len = state.doc.length;
  const { min, chunk } = state.facet(atomicChunking);
  if (len <= min) return { deco: buildAtomic(state, rv.ranges), forReveal: rv, pending: [] };
  const head = state.selection.main.head;
  const centre = near ? Math.round((near.from + near.to) / 2) : head;
  const half = Math.max(chunk, near ? near.to - near.from : 0) / 2;
  const from = Math.max(0, Math.min(centre - half, near?.from ?? centre));
  const to = Math.min(len, Math.max(centre + half, near?.to ?? centre));
  const { deco, region } = walkRegion(state, rv, keep ?? Decoration.none, from, to);
  return { deco, forReveal: rv, pending: subtract([[0, len]], [region]).filter(([a, b]) => b > a) };
}

/** The next pending chunk: in `near` when some of it is pending there, else the first one. */
function fill(value: AtomicValue, state: EditorState, near: { from: number; to: number } | null): AtomicValue {
  if (!value.pending.length) return value;
  const { chunk } = state.facet(atomicChunking);
  const hit = near && value.pending.find(([a, b]) => b > near.from && a < near.to);
  const from = hit ? Math.max(hit[0], near!.from) : value.pending[0][0];
  const end = hit ? Math.min(hit[1], Math.max(near!.to, from + chunk)) : Math.min(value.pending[0][1], from + chunk);
  const { deco, region } = walkRegion(state, value.forReveal, value.deco, from, end);
  return { deco, forReveal: value.forReveal, pending: subtract(value.pending, [region]) };
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
    return build(state, state.field(revealField), null, null);
  },
  update(value, tr) {
    const rv = tr.state.field(revealField);
    const poke = tr.effects.find((e) => e.is(resourceArrived));
    // every formula's rendering depends on the macros
    if (poke || macrosOf(tr.state) !== macrosOf(tr.startState)) {
      return build(tr.state, rv, tr.docChanged ? value.deco.map(tr.changes) : value.deco, poke?.value ?? null);
    }
    let next = value;
    if (tr.docChanged || rv !== value.forReveal || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      const pending = tr.docChanged
        ? value.pending.map(([a, b]): [number, number] => [tr.changes.mapPos(a, -1), tr.changes.mapPos(b, 1)]).filter(([a, b]) => b > a)
        : value.pending;
      const done = update(value, tr, rv);
      next = done
        ? { deco: done.deco, forReveal: rv, pending: subtract(pending, done.settled) }
        : build(tr.state, rv, tr.docChanged ? value.deco.map(tr.changes) : value.deco, null);
    }
    for (const e of tr.effects) if (e.is(buildPending)) next = fill(next, tr.state, e.value);
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).deco),
  ],
});

/**
 * The decorations of `state` with [from,to] built: what a command reading
 * them sees once a pending region there is filled, so it does not act on a
 * region that shows nothing yet. Undefined where the field is not installed.
 */
export function atomicDecoAt(state: EditorState, from: number, to: number): DecorationSet | undefined {
  const value = state.field(atomicField, false);
  if (!value?.pending.some(([a, b]) => b > from && a < to)) return value?.deco;
  return state.update({ effects: buildPending.of({ from, to }) }).state.field(atomicField).deco;
}

type Idle = (cb: (deadline: { timeRemaining(): number; didTimeout: boolean }) => void, opts?: { timeout: number }) => number;

/**
 * Builds what a long document left pending: the part in view as soon as it
 * scrolls in, the rest a chunk at a time while the browser is idle, so no
 * switch to Visual and no resource arriving blocks the page at once.
 */
export const atomicFiller = ViewPlugin.fromClass(class {
  private idle: number | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly view: EditorView) {
    this.schedule();
  }

  update() {
    this.schedule();
  }

  private pendingInView(): boolean {
    const { pending } = this.view.state.field(atomicField);
    const { from, to } = this.view.viewport;
    return pending.some(([a, b]) => b > from && a < to);
  }

  private schedule() {
    if (!this.view.state.field(atomicField).pending.length) return;
    if (this.pendingInView()) {
      if (this.soon === null) this.soon = setTimeout(() => { this.soon = null; this.step(); }, 0);
      return;
    }
    if (this.idle !== null) return;
    const idle = (window as { requestIdleCallback?: Idle }).requestIdleCallback;
    const run = (deadline?: { timeRemaining(): number; didTimeout: boolean }) => {
      this.idle = null;
      do this.step();
      while (deadline && this.view.state.field(atomicField).pending.length && deadline.timeRemaining() > 20);
    };
    this.idle = idle ? idle(run, { timeout: 2000 }) : (setTimeout(run, 50) as unknown as number);
  }

  private step() {
    if (!this.view.state.field(atomicField, false)?.pending.length) return;
    const { from, to } = this.view.viewport;
    this.view.dispatch({ effects: buildPending.of({ from, to }) });
  }

  destroy() {
    if (this.soon !== null) clearTimeout(this.soon);
    if (this.idle !== null) {
      const cancel = (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (cancel) cancel(this.idle);
      else clearTimeout(this.idle as unknown as ReturnType<typeof setTimeout>);
    }
  }
});
