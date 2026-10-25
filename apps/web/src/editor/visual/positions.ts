import { ViewPlugin } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/**
 * Where a widget's DOM sits in the document right now. A widget keeps its DOM
 * across edits elsewhere (eq() ignores position), so offsets captured when it
 * was drawn go stale after the first edit above it; this is the only position
 * a widget event may write through. Null once the DOM has left the view.
 */
export function widgetPos(view: EditorView, dom: HTMLElement): number | null {
  if (!dom.isConnected || !view.contentDOM.contains(dom)) return null;
  try {
    return view.posAtDOM(dom);
  } catch {
    return null;
  }
}

/** The innermost `name` node that starts exactly at `pos`. */
export function nodeAt(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.from < pos) return null;
    if (n.name === name) return n;
  }
  return null;
}

/**
 * A range that follows every edit (local or a collaborator's) while a widget
 * editor is open on it. `live` turns false when the view leaves Visual mode or
 * is destroyed; nothing may be written through a dead range.
 */
export interface TrackedRange { from: number; to: number; live: boolean }

const tracked = new WeakMap<EditorView, Set<TrackedRange>>();

export function trackRange(view: EditorView, from: number, to: number): TrackedRange {
  const range = { from, to, live: true };
  let set = tracked.get(view);
  if (!set) tracked.set(view, (set = new Set()));
  set.add(range);
  return range;
}

export function untrack(view: EditorView, range: TrackedRange): void {
  tracked.get(view)?.delete(range);
}

/** Insertions at either end stay outside a tracked range. */
export const rangeTracker = ViewPlugin.define((view) => ({
  update(u) {
    if (!u.docChanged) return;
    for (const r of tracked.get(view) ?? []) {
      r.from = u.changes.mapPos(r.from, 1);
      r.to = Math.max(r.from, u.changes.mapPos(r.to, -1));
    }
  },
  destroy() {
    for (const r of tracked.get(view) ?? []) r.live = false;
    tracked.delete(view);
  },
}));
