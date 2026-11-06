import { EditorSelection, findClusterBreak } from '@codemirror/state';
import type { EditorState, SelectionRange } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { MouseSelectionStyle, ViewUpdate } from '@codemirror/view';
import { revealField, type RevealState } from './reveal';

/** Pointer travel in pixels past which a held click is a drag; CodeMirror's own threshold. */
const DRAG = 10;

/**
 * The run of word, space or other characters at `pos` that a double-click
 * selects. Copied from @codemirror/view (internal groupAt, not exported).
 */
export function groupAt(state: EditorState, pos: number, bias = 1): SelectionRange {
  const categorize = state.charCategorizer(pos);
  const line = state.doc.lineAt(pos);
  const linePos = pos - line.from;
  if (line.length === 0) return EditorSelection.cursor(pos);
  if (linePos === 0) bias = 1;
  else if (linePos === line.length) bias = -1;
  let from = linePos;
  let to = linePos;
  if (bias < 0) from = findClusterBreak(line.text, linePos, false);
  else to = findClusterBreak(line.text, linePos);
  const cat = categorize(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(prev, from)) !== cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== cat) break;
    to = next;
  }
  return EditorSelection.undirectionalRange(from + line.from, to + line.from);
}

/** What the `type`th click of a sequence selects at `pos`: the word for 2, the drawn line with its line break from 3 on. */
function rangeForClick(view: EditorView, pos: number, assoc: -1 | 1, type: number): SelectionRange {
  if (type === 2) return groupAt(view.state, pos, assoc);
  const block = view.lineBlockAt(pos);
  const line = view.state.doc.lineAt(block.to);
  const to = block.to < view.state.doc.length && block.to === line.to ? block.to + 1 : block.to;
  return EditorSelection.undirectionalRange(block.from, to);
}

/** A sequence's first click: where it landed as the text was drawn then, what showed as source then, and the count of the sequence's latest mousedown. */
interface FirstClick { down: number; pos: number; assoc: -1 | 1; reveal: RevealState }

/**
 * CodeMirror's mouse selection for the later clicks of a sequence, started
 * at the first click's position instead of the one under the pointer now.
 * Once the pointer travels past DRAG the gesture follows it as drawn now.
 */
function sequenceStyle(view: EditorView, down: MouseEvent, first: FirstClick): MouseSelectionStyle {
  const type = down.detail;
  const start = { pos: first.pos, assoc: first.assoc };
  let startSel = view.state.selection;
  let dragged = false;
  return {
    update(u) {
      if (!u.docChanged) return;
      start.pos = u.changes.mapPos(start.pos, start.assoc);
      startSel = startSel.map(u.changes);
    },
    get(event, extend, multiple) {
      dragged ||= Math.max(Math.abs(event.clientX - down.clientX), Math.abs(event.clientY - down.clientY)) >= DRAG;
      const cur = dragged ? view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false) : start;
      let range = rangeForClick(view, cur.pos, cur.assoc, type);
      if (cur.pos !== start.pos && !extend) {
        const startRange = rangeForClick(view, start.pos, start.assoc, type);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
      if (multiple) return startSel.addRange(range);
      return EditorSelection.create([range]);
    },
  };
}

/**
 * The first click of a double or triple click may show or hide source, which
 * moves the text under the pointer before the next click lands. The later
 * clicks of the sequence select at the first click's position, as the text
 * was drawn then; where nothing moved, CodeMirror's own mouse selection runs.
 */
export const clickSequence = ViewPlugin.fromClass(class {
  downs = 0;
  private first: FirstClick | null = null;

  update(u: ViewUpdate) {
    if (this.first && u.docChanged) this.first.pos = u.changes.mapPos(this.first.pos, this.first.assoc);
  }

  /** The sequence's first click, when `event` continues it and the text has moved since it began. */
  retarget(view: EditorView, event: MouseEvent): FirstClick | null {
    const first = this.first;
    if (event.button !== 0 || event.detail < 2 || !first || first.down !== this.downs - 1) return null;
    return view.state.field(revealField) === first.reveal ? null : first;
  }

  style(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
    if (event.button !== 0) return null;
    const first = this.first;
    if (event.detail < 2 || !first || first.down !== this.downs - 1) {
      const at = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
      this.first = { down: this.downs, pos: at.pos, assoc: at.assoc, reveal: view.state.field(revealField) };
      return null;
    }
    const from = this.retarget(view, event);
    first.down = this.downs;
    return from && sequenceStyle(view, event, from);
  }
}, {
  eventObservers: {
    // every mousedown counts, also those a widget takes, so a sequence is only ever consecutive clicks
    mousedown() { this.downs++; },
  },
  provide: (plugin) => EditorView.mouseSelectionStyle.of((view, event) => view.plugin(plugin)?.style(view, event) ?? null),
});

/** Whether `event` is a later click of a sequence whose text has moved: it selects text, even where a widget moved under the pointer. */
export function retargetsClick(view: EditorView, event: MouseEvent): boolean {
  return !!view.plugin(clickSequence)?.retarget(view, event);
}
