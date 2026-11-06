import { ViewPlugin, layer } from '@codemirror/view';
import type { EditorView, LayerMarker, ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { ySyncFacet } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import { atomicField } from './atomicField';

/** The awareness field that says whether a collaborator's editor has focus. */
const FOCUSED = 'focused';

/**
 * Publishes whether this editor has focus, in Source and Visual alike:
 * y-codemirror keeps a caret in the awareness after its editor loses focus,
 * and a collaborator's Visual ignores a caret whose editor is not focused.
 */
export function publishEditorFocus(awareness: Awareness): Extension {
  return ViewPlugin.define((view) => {
    const publish = () => {
      const state = awareness.getLocalState();
      if (state && state[FOCUSED] !== view.hasFocus) awareness.setLocalStateField(FOCUSED, view.hasFocus);
    };
    publish();
    return { update(u: ViewUpdate) { if (u.focusChanged) publish(); } };
  });
}

/** A collaborator's caret, mapped to this document. */
export interface PeerCaret { pos: number; color: string; name: string }

export const setPeerCarets = StateEffect.define<PeerCaret[]>();

export const peerCaretField = StateField.define<PeerCaret[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPeerCarets)) return e.value;
    return tr.docChanged ? value.map((p) => ({ ...p, pos: tr.changes.mapPos(p.pos) })) : value;
  },
});

/** Only a plain colour from a collaborator's awareness goes into a style. */
const safeColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : 'var(--accent)');

/** An outline in a collaborator's colour around the widget their caret is in. */
class PeerBox implements LayerMarker {
  constructor(readonly left: number, readonly top: number, readonly width: number, readonly height: number, readonly color: string, readonly name: string) {}

  eq(o: LayerMarker): boolean {
    return o instanceof PeerBox && o.left === this.left && o.top === this.top && o.width === this.width
      && o.height === this.height && o.color === this.color && o.name === this.name;
  }

  draw(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-vis-peer';
    el.setAttribute('data-testid', 'vis-peer-outline');
    this.adjust(el);
    return el;
  }

  update(el: HTMLElement, prev: LayerMarker): boolean {
    if (!(prev instanceof PeerBox)) return false;
    this.adjust(el);
    return true;
  }

  private adjust(el: HTMLElement) {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    el.style.setProperty('--vis-peer', this.color);
    el.title = `${this.name}'s cursor is here`;
  }
}

function peerBoxes(view: EditorView): PeerBox[] {
  const peers = view.state.field(peerCaretField);
  if (!peers.length) return [];
  const deco = view.state.field(atomicField).deco;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft;
  const baseTop = scroller.top - view.scrollDOM.scrollTop;
  const out: PeerBox[] = [];
  for (const p of peers) {
    deco.between(p.pos, p.pos, (from, to, d) => {
      if (!(from < p.pos && p.pos < to && d.spec.widget) || to < view.viewport.from || from > view.viewport.to) return;
      const a = view.coordsAtPos(from, 1);
      const b = view.coordsAtPos(to, -1);
      if (!a || !b) return;
      const top = Math.min(a.top, b.top);
      const left = Math.min(a.left, b.left);
      out.push(new PeerBox(left - baseLeft, top - baseTop, Math.max(2, Math.max(a.right, b.right) - left), Math.max(a.bottom, b.bottom) - top, p.color, p.name));
    });
  }
  return out;
}

/**
 * A collaborator's caret inside a construct Visual draws as one widget (a
 * chip, a formula, a table) outlines that widget in their colour: it never
 * shows the source here, so it cannot reflow the page or close an open cell
 * editor. The outline is a layer over the text, so the widget's DOM (and a
 * cell editor in it) stays where it is. Carets whose editor is not focused
 * are left out, as are those outside widgets, which y-codemirror draws.
 */
export function peerOutlines(awareness: Awareness): Extension {
  const reader = ViewPlugin.define((view: EditorView) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const push = () => {
      timer = null;
      const conf = view.state.facet(ySyncFacet);
      if (!conf) return;
      const peers: PeerCaret[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const s = state as { cursor?: { head?: unknown }; user?: { name?: unknown; color?: unknown }; [FOCUSED]?: unknown };
        if (!s.cursor?.head || s[FOCUSED] === false) return;
        try {
          peers.push({ pos: conf.fromYPos(s.cursor.head).pos, color: safeColor(s.user?.color), name: typeof s.user?.name === 'string' ? s.user.name : 'A collaborator' });
        } catch {
          /* stale position from another doc epoch — ignore */
        }
      });
      peers.sort((a, b) => a.pos - b.pos);
      const key = JSON.stringify(peers);
      if (key === last) return;
      last = key;
      view.dispatch({ effects: setPeerCarets.of(peers) });
    };
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 60);
    };
    awareness.on('change', onChange);
    onChange();
    return {
      destroy() {
        awareness.off('change', onChange);
        if (timer) clearTimeout(timer);
      },
    };
  });
  const boxes = layer({
    above: true,
    class: 'cm-vis-peers',
    update: (u) => u.docChanged || u.geometryChanged || u.viewportChanged
      || u.state.field(peerCaretField) !== u.startState.field(peerCaretField)
      || u.state.field(atomicField) !== u.startState.field(atomicField),
    markers: peerBoxes,
  });
  return [peerCaretField, reader, boxes];
}
