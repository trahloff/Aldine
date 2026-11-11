/**
 * Change marks: what the open file changed since the branch's baseline
 * (server gitops.diffBaselineCommit — the last checkpoint, or with manual
 * commits the last commit), the way an IDE marks uncommitted lines. A bar
 * beside each added (green) or changed (blue) line, a notch between lines
 * where lines were removed (red). Clicking a mark opens the earlier text
 * under the lines, with a way to put it back. The comparison runs a moment
 * after the typing stops; between runs the marks follow the text. Pure
 * decoration until a person asks for the revert.
 */
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, type DecorationSet } from '@codemirror/view';
import { Prec, RangeSet, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { diffLines, splitLines, type Hunk } from './lineDiff';

/** The baseline's text by line; null when the file was not in it (every line is new). */
export interface DiffBaseline { commit: string; lines: string[] | null }

/** What the baseline is called in the marks' titles and the earlier-text panel. */
export type BaselineNoun = 'checkpoint' | 'commit';

/** Pause in typing before the marks are compared again. */
const RECOMPUTE_MS = 250;

export const setDiffBaseline = StateEffect.define<DiffBaseline | null>();
const recompute = StateEffect.define<null>();
/** Open the earlier text of the hunk on this line (a position in it), or close it. */
const setPeek = StateEffect.define<number | null>();

interface DiffState {
  base: DiffBaseline | null;
  noun: BaselineNoun;
  hunks: Hunk[];
  marks: RangeSet<GutterMarker>;
  /** A position on the open hunk's first line; null: none open. */
  peek: number | null;
  peekDeco: DecorationSet;
}

type MarkKind = 'add' | 'mod' | 'del' | 'del-end';

const TITLES: Record<MarkKind, (noun: BaselineNoun) => string> = {
  add: (n) => `Added since the last ${n}. Click to show what changed`,
  mod: (n) => `Changed since the last ${n}. Click to show the earlier text`,
  del: (n) => `Lines removed here since the last ${n}. Click to show them`,
  'del-end': (n) => `Lines removed here since the last ${n}. Click to show them`,
};

class DiffMarker extends GutterMarker {
  constructor(readonly kind: MarkKind, readonly noun: BaselineNoun) { super(); }
  eq(other: GutterMarker) { return other instanceof DiffMarker && other.kind === this.kind && other.noun === this.noun; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-diff-mark cm-diff-mark--${this.kind}`;
    el.title = TITLES[this.kind](this.noun);
    el.setAttribute('data-testid', 'diff-gutter-mark');
    el.setAttribute('data-kind', this.kind === 'del-end' ? 'del' : this.kind);
    return el;
  }
}

/** Sizes the column while no line is marked; not a mark itself. */
const spacer = new (class extends GutterMarker {
  toDOM() { const el = document.createElement('span'); el.className = 'cm-diff-mark'; return el; }
})();

/** The hunk a click on line `line` means: one covering it, or a removal marked on it. */
export function hunkAtLine(hunks: Hunk[], line: number, lines: number): Hunk | null {
  for (const h of hunks) {
    if (h.kind === 'del') {
      if (Math.min(h.from, lines) === line) return h;
    } else if (h.from <= line && line <= h.to) return h;
  }
  return null;
}

function computeHunks(base: DiffBaseline | null, doc: Text): Hunk[] {
  if (!base) return [];
  const now = doc.toString();
  if (base.lines === null) return now === '' ? [] : [{ kind: 'add', from: 1, to: doc.lines, old: [] }];
  return diffLines(base.lines, splitLines(now));
}

function markSet(hunks: Hunk[], doc: Text, noun: BaselineNoun): RangeSet<GutterMarker> {
  const ranges = [];
  for (const h of hunks) {
    if (h.kind === 'del') {
      const end = h.from > doc.lines;
      ranges.push(new DiffMarker(end ? 'del-end' : 'del', noun).range(doc.line(Math.min(h.from, doc.lines)).from));
      continue;
    }
    const marker = new DiffMarker(h.kind, noun);
    for (let l = h.from; l <= Math.min(h.to, doc.lines); l++) ranges.push(marker.range(doc.line(l).from));
  }
  return RangeSet.of(ranges, true);
}

/** The document change that puts the hunk's earlier lines back. */
export function revertChange(h: Hunk, doc: Text): { from: number; to: number; insert: string } {
  if (h.kind === 'mod') return { from: doc.line(h.from).from, to: doc.line(Math.min(h.to, doc.lines)).to, insert: h.old.join('\n') };
  if (h.kind === 'del') {
    if (h.from > doc.lines) return { from: doc.length, to: doc.length, insert: `\n${h.old.join('\n')}` };
    return { from: doc.line(h.from).from, to: doc.line(h.from).from, insert: `${h.old.join('\n')}\n` };
  }
  // add: the lines go, with one of the line breaks around them
  const last = Math.min(h.to, doc.lines);
  if (last < doc.lines) return { from: doc.line(h.from).from, to: doc.line(last + 1).from, insert: '' };
  if (h.from > 1) return { from: doc.line(h.from - 1).to, to: doc.line(last).to, insert: '' };
  return { from: 0, to: doc.length, insert: '' };
}

class PeekWidget extends WidgetType {
  constructor(readonly hunk: Hunk, readonly noun: BaselineNoun, readonly canRevert: boolean) { super(); }
  eq(other: PeekWidget) {
    return other.hunk.kind === this.hunk.kind && other.hunk.from === this.hunk.from && other.hunk.to === this.hunk.to
      && other.noun === this.noun && other.canRevert === this.canRevert
      && other.hunk.old.length === this.hunk.old.length && other.hunk.old.every((l, i) => l === this.hunk.old[i]);
  }
  toDOM(view: EditorView) {
    const { hunk, noun } = this;
    const box = document.createElement('div');
    box.className = `cm-diff-peek cm-diff-peek--${hunk.kind}`;
    box.setAttribute('data-testid', 'diff-peek');
    const head = document.createElement('div');
    head.className = 'cm-diff-peek__head';
    const label = document.createElement('span');
    label.className = 'cm-diff-peek__label';
    label.textContent = hunk.kind === 'add' ? `New since the last ${noun}` : `At the last ${noun}`;
    head.append(label);
    const button = (text: string, testid: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--small';
      b.textContent = text;
      b.setAttribute('data-testid', testid);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.preventDefault(); run(); });
      return b;
    };
    if (this.canRevert) {
      const text = hunk.kind === 'add' ? 'Remove these lines' : hunk.kind === 'del' ? 'Restore these lines' : 'Revert these lines';
      head.append(button(text, 'diff-peek-revert', () => revertOpenHunk(view)));
    }
    head.append(button('Close', 'diff-peek-close', () => view.dispatch({ effects: setPeek.of(null) })));
    box.append(head);
    if (hunk.old.length) {
      const old = document.createElement('div');
      old.className = 'cm-diff-peek__old';
      old.setAttribute('data-testid', 'diff-peek-old');
      for (const line of hunk.old) {
        const row = document.createElement('div');
        row.textContent = line || '​';
        old.append(row);
      }
      box.append(old);
    }
    return box;
  }
  ignoreEvent() { return true; }
}

function peekDecorations(hunk: Hunk | null, state: EditorState, noun: BaselineNoun): DecorationSet {
  if (!hunk) return Decoration.none;
  const doc = state.doc;
  const widget = new PeekWidget(hunk, noun, !state.readOnly);
  // Under the changed lines; for a removal, where the lines were.
  if (hunk.kind === 'del' && hunk.from <= doc.lines) {
    return Decoration.set(Decoration.widget({ widget, block: true, side: -1 }).range(doc.line(hunk.from).from));
  }
  const last = hunk.kind === 'del' ? doc.lines : Math.min(hunk.to, doc.lines);
  return Decoration.set(Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(last).to));
}

function revertOpenHunk(view: EditorView): void {
  const s = view.state.field(diffField, false);
  if (!s || s.peek === null || view.state.readOnly) return;
  const doc = view.state.doc;
  const h = hunkAtLine(s.hunks, doc.lineAt(Math.min(s.peek, doc.length)).number, doc.lines);
  if (!h) return;
  view.dispatch({ changes: revertChange(h, doc), effects: [setPeek.of(null), recompute.of(null)], userEvent: 'input' });
  view.focus();
}

const diffField = StateField.define<DiffState>({
  create: () => ({ base: null, noun: 'checkpoint', hunks: [], marks: RangeSet.empty, peek: null, peekDeco: Decoration.none }),
  update(value, tr) {
    const { noun } = value;
    let { base, hunks, marks, peek, peekDeco } = value;
    if (tr.docChanged) {
      // Between comparisons the marks and the open panel follow the text.
      marks = marks.map(tr.changes);
      peekDeco = peekDeco.map(tr.changes);
      if (peek !== null) peek = tr.changes.mapPos(peek, -1);
    }
    let fresh = false;
    let peekChanged = false;
    for (const e of tr.effects) {
      if (e.is(setDiffBaseline)) { base = e.value; fresh = true; }
      else if (e.is(recompute)) fresh = true;
      else if (e.is(setPeek)) { peek = e.value; peekChanged = true; }
    }
    if (!fresh && !peekChanged) return tr.docChanged ? { base, noun, hunks, marks, peek, peekDeco } : value;
    const doc = tr.state.doc;
    if (fresh) {
      hunks = computeHunks(base, doc);
      marks = markSet(hunks, doc, noun);
    }
    const open = peek === null ? null : hunkAtLine(hunks, doc.lineAt(Math.min(peek, doc.length)).number, doc.lines);
    if (!open) peek = null;
    else peek = doc.line(Math.min(open.from, doc.lines)).from;
    peekDeco = peekDecorations(open, tr.state, noun);
    return { base, noun, hunks, marks, peek, peekDeco };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.peekDeco),
});

/**
 * The change marks against `base` (null until the baseline has loaded; a
 * setDiffBaseline effect gives it later). `noun` names the baseline.
 */
export function diffGutter(base: DiffBaseline | null, noun: BaselineNoun): Extension {
  return [
    diffField.init((state) => {
      const hunks = computeHunks(base, state.doc);
      return { base, noun, hunks, marks: markSet(hunks, state.doc, noun), peek: null, peekDeco: Decoration.none };
    }),
    gutter({
      class: 'cm-diff-gutter',
      markers: (view) => view.state.field(diffField).marks,
      initialSpacer: () => spacer,
      domEventHandlers: {
        mousedown(view, line) {
          const s = view.state.field(diffField);
          const doc = view.state.doc;
          const n = doc.lineAt(line.from).number;
          const h = hunkAtLine(s.hunks, n, doc.lines);
          if (!h) return false;
          const start = doc.line(Math.min(h.from, doc.lines)).from;
          view.dispatch({ effects: setPeek.of(s.peek === start ? null : start) });
          return true;
        },
      },
    }),
    Prec.high(keymap.of([{
      key: 'Escape',
      run: (view) => {
        if (view.state.field(diffField).peek === null) return false;
        view.dispatch({ effects: setPeek.of(null) });
        return true;
      },
    }])),
    ViewPlugin.define((view) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return {
        update(u) {
          if (!u.docChanged) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { timer = null; view.dispatch({ effects: recompute.of(null) }); }, RECOMPUTE_MS);
        },
        destroy() { if (timer) clearTimeout(timer); },
      };
    }),
  ];
}
