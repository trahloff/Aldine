/**
 * Claude's changes, marked in the gutter until the person has seen them.
 * The server records every span an agent write changes in a side map of the
 * document (server collab.ts AGENT_EDITS_KEY) as Yjs relative positions, so
 * a mark stays on the text it was made on while people edit around it, and
 * nothing else is ever marked — a co-author's typing never is. A line Claude
 * wrote gets a violet bar, a line where it only removed text a notch.
 * Marks older than the person's review mark (the agent review prompt's
 * "seen") are not shown. Pure decoration: it never touches document bytes.
 */
import * as Y from 'yjs';
import { GutterMarker, ViewPlugin, gutter, type EditorView } from '@codemirror/view';
import { RangeSet, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';

/** The side map's name, a wire identifier shared with the server. */
export const AGENT_EDITS_KEY = 'agentEdits';

/** One mark where it sits now: `ins` text Claude wrote [from, to), `del` the point where it removed text. */
export interface AgentMark { key: string; kind: 'ins' | 'del'; from: number; to: number; t: number }

interface Stored { k?: unknown; a?: unknown; b?: unknown; t?: unknown }

/** Where the stored marks (all, or `keys`) sit in the text now. An insert
 *  whose text has all been deleted since is gone. */
export function resolveMarks(ydoc: Y.Doc, ytext: Y.Text, keys?: Iterable<string>): AgentMark[] {
  const map = ydoc.getMap<Stored>(AGENT_EDITS_KEY);
  const at = (json: unknown): number | null => {
    if (!json || typeof json !== 'object') return null;
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ydoc);
      return pos && pos.type === ytext ? pos.index : null;
    } catch { return null; }
  };
  const out: AgentMark[] = [];
  for (const key of keys ?? map.keys()) {
    const v = map.get(key);
    if (!v || typeof v.t !== 'number') continue;
    const from = at(v.a);
    if (from === null) continue;
    if (v.k === 'del') { out.push({ key, kind: 'del', from, to: from, t: v.t }); continue; }
    if (v.k !== 'ins') continue;
    const to = at(v.b);
    if (to === null || to <= from) continue;
    out.push({ key, kind: 'ins', from, to, t: v.t });
  }
  return out;
}

/** The lines to mark, ascending: a line any unseen insert touches, else one an
 *  unseen deletion happened on. Nothing while the review mark is unknown. */
export function markedLines(doc: Text, marks: AgentMark[], seenAt: number | null): Array<{ line: number; kind: 'ins' | 'del' }> {
  if (seenAt === null) return [];
  const byLine = new Map<number, 'ins' | 'del'>();
  for (const m of marks) {
    if (m.t <= seenAt || m.from > doc.length) continue;
    if (m.kind === 'del') {
      const line = doc.lineAt(m.from).number;
      if (!byLine.has(line)) byLine.set(line, 'del');
      continue;
    }
    const first = doc.lineAt(m.from).number;
    const last = doc.lineAt(Math.max(m.from, Math.min(m.to, doc.length) - 1)).number;
    for (let l = first; l <= last; l++) byLine.set(l, 'ins');
  }
  return [...byLine].sort((x, y) => x[0] - y[0]).map(([line, kind]) => ({ line, kind }));
}

class AgentLineMarker extends GutterMarker {
  constructor(readonly kind: 'ins' | 'del') { super(); }
  eq(other: GutterMarker) { return other instanceof AgentLineMarker && other.kind === this.kind; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-agent-mark cm-agent-mark--${this.kind}`;
    el.title = this.kind === 'ins' ? 'Changed by Claude since your last review' : 'Claude removed text here since your last review';
    el.setAttribute('data-testid', 'agent-gutter-mark');
    el.setAttribute('data-kind', this.kind);
    return el;
  }
}
const insMarker = new AgentLineMarker('ins');
const delMarker = new AgentLineMarker('del');
/** Sizes the column while no line is marked; not a mark itself. */
const spacer = new (class extends GutterMarker {
  toDOM() { const el = document.createElement('span'); el.className = 'cm-agent-mark'; return el; }
})();

/** The review mark moved (or became known): marks at or before it hide. */
export const setAgentSeen = StateEffect.define<number | null>();
const setMarks = StateEffect.define<AgentMark[]>();

interface MarksState { marks: AgentMark[]; seenAt: number | null; lines: RangeSet<GutterMarker> }

function lineSet(doc: Text, marks: AgentMark[], seenAt: number | null): RangeSet<GutterMarker> {
  return RangeSet.of(markedLines(doc, marks, seenAt).map((l) => (l.kind === 'ins' ? insMarker : delMarker).range(doc.line(l.line).from)));
}

/** `seenAt`: the review mark (server ms), null while unknown. */
export function agentMarks(ydoc: Y.Doc, ytext: Y.Text, seenAt: number | null): Extension {
  const field = StateField.define<MarksState>({
    create(state) {
      const marks = resolveMarks(ydoc, ytext);
      return { marks, seenAt, lines: lineSet(state.doc, marks, seenAt) };
    },
    update(value, tr) {
      let { marks, seenAt: seen } = value;
      let dirty = false;
      if (tr.docChanged) {
        // Between the server's updates the marks follow the text the way
        // their relative positions do: the start sticks to the right, the
        // end to the left, so typing at either edge does not grow a span.
        marks = marks
          .map((m) => ({ ...m, from: tr.changes.mapPos(m.from, 1), to: m.kind === 'del' ? tr.changes.mapPos(m.from, 1) : tr.changes.mapPos(m.to, -1) }))
          .filter((m) => m.kind === 'del' || m.to > m.from);
        dirty = true;
      }
      for (const e of tr.effects) {
        if (e.is(setMarks)) { marks = e.value; dirty = true; }
        else if (e.is(setAgentSeen)) { seen = e.value; dirty = true; }
      }
      return dirty ? { marks, seenAt: seen, lines: lineSet(tr.state.doc, marks, seen) } : value;
    },
  });
  return [
    field,
    gutter({
      class: 'cm-agent-gutter',
      markers: (view) => view.state.field(field).lines,
      initialSpacer: () => spacer,
    }),
    ViewPlugin.define((view: EditorView) => {
      const map = ydoc.getMap(AGENT_EDITS_KEY);
      // afterTransaction runs after every observer, y-sync's among them: a
      // remote change has reached the view by then, so the positions hold.
      const onAfter = (tr: Y.Transaction) => {
        if (!tr.changed.has(map as unknown as Y.AbstractType<Y.YEvent<any>>)) return;
        view.dispatch({ effects: setMarks.of(resolveMarks(ydoc, ytext)) });
      };
      ydoc.on('afterTransaction', onAfter);
      return { destroy() { ydoc.off('afterTransaction', onAfter); } };
    }),
  ];
}
