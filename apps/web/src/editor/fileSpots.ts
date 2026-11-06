import { EditorSelection, type ChangeDesc } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { safeStorage, type SafeStore } from '../util/safeStorage';

/**
 * Where the editor left a file: the selection, and the text at the top edge
 * of the viewport with how far below that edge it starts (px, negative when
 * its line is cut off there).
 */
export interface Spot { anchor: number; head: number; top: number; margin: number }

/** Keyed by collab doc name (project::branch::path); past MAX the oldest go. */
const KEY = 'aldine.fileSpots';
const MAX = 100;

/** Null when the pane has no layout to read a scroll position from. */
export function captureSpot(view: EditorView): Spot | null {
  const box = view.scrollDOM.getBoundingClientRect();
  if (!view.dom.isConnected || box.height <= 0) return null;
  const { anchor, head } = view.state.selection.main;
  const left = view.contentDOM.getBoundingClientRect().left;
  const top = view.posAtCoords({ x: left + 1, y: box.top + 1 }, false);
  const at = view.coordsAtPos(top, 1);
  return { anchor, head, top, margin: at ? Math.round(at.top - box.top) : 0 };
}

export function clampSpot(s: Spot, length: number): Spot {
  const c = (n: number) => Math.min(Math.max(0, n), length);
  return { anchor: c(s.anchor), head: c(s.head), top: c(s.top), margin: s.margin };
}

export function mapSpot(s: Spot, changes: ChangeDesc): Spot {
  const sel = EditorSelection.single(s.anchor, s.head).map(changes).main;
  return { anchor: sel.anchor, head: sel.head, top: changes.mapPos(s.top, -1), margin: s.margin };
}

export function spotSelection(s: Spot) {
  return EditorSelection.single(s.anchor, s.head);
}

/** Aligns the text the way captureSpot measured it, so a round trip does not drift. */
export function spotScroll(s: Spot) {
  return EditorView.scrollIntoView(s.top, { y: 'start', yMargin: s.margin });
}

export interface SpotStore {
  get(name: string): Spot | null;
  set(name: string, spot: Spot): void;
  /** Follows edits to a file nobody is looking at; kept by the next set or flush. */
  map(name: string, changes: ChangeDesc): void;
  flush(): void;
}

const isSpotTuple = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n)) && v[0] >= 0 && v[1] >= 0 && v[2] >= 0;

export function makeSpotStore(store: SafeStore = safeStorage, max = MAX): SpotStore {
  let mem: Map<string, Spot> | null = null;
  const load = (): Map<string, Spot> => {
    if (mem) return mem;
    const raw = store.getJSON<Record<string, unknown>>(KEY, {}, (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
    mem = new Map();
    for (const [name, v] of Object.entries(raw)) {
      if (isSpotTuple(v)) mem.set(name, { anchor: v[0], head: v[1], top: v[2], margin: v[3] });
    }
    return mem;
  };
  const flush = () => {
    const out: Record<string, [number, number, number, number]> = {};
    for (const [name, s] of load()) out[name] = [s.anchor, s.head, s.top, s.margin];
    store.setJSON(KEY, out);
  };
  return {
    get: (name) => load().get(name) ?? null,
    set(name, spot) {
      const m = load();
      m.delete(name); // re-inserted last: insertion order is recency
      m.set(name, spot);
      for (const oldest of m.keys()) {
        if (m.size <= max) break;
        m.delete(oldest);
      }
      flush();
    },
    map(name, changes) {
      const m = load();
      const s = m.get(name);
      if (s) m.set(name, mapSpot(s, changes));
    },
    flush,
  };
}

export const fileSpots = makeSpotStore();
