/**
 * Fade highlight for agent edits: text Claude just wrote gets an
 * agent-violet background tint that decays over ~4 s. Pure decoration — it
 * never touches document bytes (the visual editor's byte-stability contract
 * also binds this layer).
 *
 * Attribution is explicit: the server marks every span an agent write
 * changes in the document's side map (editor/agentMarks.ts), in the same
 * update as the change, and only spans that arrive that way are tinted —
 * never a co-author's typing, whatever else is in awareness.
 */
import { EditorView, Decoration, DecorationSet, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect, Extension } from '@codemirror/state';
import type * as Y from 'yjs';
import { AGENT_EDITS_KEY, resolveMarks } from './agentMarks';

const FADE_MS = 4000;

/** Keys a transaction added to the side map: the agent writes it carried. */
export function addedKeys(event: { changes: { keys: Map<string, { action: string }> } }): string[] {
  return [...event.changes.keys].filter(([, c]) => c.action === 'add').map(([key]) => key);
}

const addFade = StateEffect.define<{ ranges: Array<{ from: number; to: number }>; at: number }>({
  map: (v, m) => ({ at: v.at, ranges: v.ranges.map((r) => ({ from: m.mapPos(r.from), to: m.mapPos(r.to) })) }),
});
const pruneFade = StateEffect.define<number>(); // drop marks stamped at or before this time

const fadeField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFade)) {
        const len = tr.state.doc.length;
        const marks = e.value.ranges
          .filter((r) => r.from < r.to && r.to <= len)
          .map((r) => Decoration.mark({ class: 'cm-agent-edit', agentAt: e.value.at }).range(r.from, r.to));
        if (marks.length) deco = deco.update({ add: marks, sort: true });
      } else if (e.is(pruneFade)) {
        deco = deco.update({ filter: (_f, _t, d) => ((d.spec as { agentAt?: number }).agentAt ?? 0) > e.value });
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * `live()`: whether the doc has had its first sync. The marks that sync
 * brings are old ones; only those arriving afterwards are being written now.
 */
export function agentHighlight(ydoc: Y.Doc, ytext: Y.Text, live: () => boolean): Extension {
  return [
    fadeField,
    ViewPlugin.define((view) => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const map = ydoc.getMap(AGENT_EDITS_KEY);
      let fresh: string[] = [];
      const onMap = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
        if (!tr.local && live()) fresh.push(...addedKeys(event));
      };
      // Tinted once the transaction is through: y-sync applies the text from
      // its own observer, and the ranges hold in the view only after it.
      const onAfter = () => {
        if (!fresh.length) return;
        const keys = fresh;
        fresh = [];
        const ranges = resolveMarks(ydoc, ytext, keys).filter((m) => m.kind === 'ins').map(({ from, to }) => ({ from, to }));
        if (!ranges.length) return;
        const at = Date.now();
        view.dispatch({ effects: addFade.of({ ranges, at }) });
        const t = setTimeout(() => {
          timers.delete(t);
          view.dispatch({ effects: pruneFade.of(at) });
        }, FADE_MS + 100);
        timers.add(t);
      };
      map.observe(onMap);
      ydoc.on('afterTransaction', onAfter);
      return {
        destroy() {
          map.unobserve(onMap);
          ydoc.off('afterTransaction', onAfter);
          timers.forEach(clearTimeout);
        },
      };
    }),
  ];
}
