/**
 * Fade highlight for agent edits: ranges inserted by remote Yjs transactions
 * while an agent session is active get an agent-violet background tint that
 * decays over ~4 s. Pure decoration — it never touches document bytes (the
 * visual editor's byte-stability contract also binds this layer).
 *
 * Attribution note: Yjs transaction origins do not cross the wire (the server
 * stamps AGENT_ORIGIN, but every remote update arrives here with the provider
 * as origin), so agent edits are identified by correlating remote transactions
 * with the agent's broadcast awareness state (`user.isAgent`). While an agent
 * session is live, a human collaborator's concurrent remote edits can pick up
 * the tint too — accepted for this experimental affordance.
 */
import { EditorView, Decoration, DecorationSet, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect, Extension } from '@codemirror/state';
import type * as Y from 'yjs';

type AwarenessLike = { getStates(): Map<number, Record<string, unknown>> };

const FADE_MS = 4000;

/**
 * Inserted ranges of a Y.Text delta, in NEW-document coordinates — after the
 * y-sync plugin applies the same delta, these offsets are valid in the editor.
 */
export function insertedRanges(delta: Array<{ retain?: number; insert?: string | object; delete?: number }>): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let pos = 0;
  for (const d of delta) {
    if (d.retain != null) pos += d.retain;
    else if (d.insert != null) {
      const len = typeof d.insert === 'string' ? d.insert.length : 1;
      ranges.push({ from: pos, to: pos + len });
      pos += len;
    }
    // deletes consume old content only — no new-doc movement
  }
  return ranges;
}

/** True when any awareness state carries the agent identity. */
export function agentActive(awareness: AwarenessLike): boolean {
  for (const s of awareness.getStates().values()) {
    if ((s as { user?: { isAgent?: boolean } }).user?.isAgent) return true;
  }
  return false;
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
 * Must sit AFTER yCollab in the extension list: the observer below has to
 * register after y-sync's so it fires once the editor already reflects the
 * remote change (offsets valid, dispatch legal).
 */
export function agentHighlight(ytext: Y.Text, awareness: AwarenessLike): Extension {
  return [
    fadeField,
    ViewPlugin.define((view) => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const observer = (event: Y.YTextEvent, tr: { local: boolean }) => {
        if (tr.local || !agentActive(awareness)) return;
        const ranges = insertedRanges(event.delta as Array<{ retain?: number; insert?: string; delete?: number }>);
        if (!ranges.length) return;
        const at = Date.now();
        view.dispatch({ effects: addFade.of({ ranges, at }) });
        const t = setTimeout(() => {
          timers.delete(t);
          view.dispatch({ effects: pruneFade.of(at) });
        }, FADE_MS + 100);
        timers.add(t);
      };
      ytext.observe(observer);
      return {
        destroy() {
          ytext.unobserve(observer);
          timers.forEach(clearTimeout);
        },
      };
    }),
  ];
}
