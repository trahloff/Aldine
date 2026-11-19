import { StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * A jump (SyncTeX, the outline, a deep link, Go to line) scrolls by the
 * heights CodeMirror knows at that moment. Lines it has never drawn have
 * estimated heights, and in Visual a table, figure or formula takes its real
 * height only once the parser reaches it and KaTeX or the figure preview has
 * arrived. CodeMirror then keeps the top of the viewport still, not the
 * target, which in a long document drifts thousands of pixels off screen.
 * The hold re-centres the target while the heights settle, until the reader
 * scrolls, clicks or types.
 */

const holdJump = StateEffect.define<number>({ map: (pos, changes) => changes.mapPos(pos) });

/** Long enough for a fresh document's parse and first draw to finish. */
const HOLD_MS = 1500;
/** Each correction keeps the hold this much longer, up to MAX_MS in all. */
const AFTER_FIX_MS = 500;
const MAX_MS = 5000;
/** The target counts as placed while it sits this far (of the height) from either edge. */
const BAND = 0.15;
const USER_EVENTS = ['wheel', 'mousedown', 'touchstart'] as const;

/** Effects that scroll `pos` to the middle of the editor and keep it there while heights settle. */
export function jumpEffects(pos: number): StateEffect<unknown>[] {
  return [EditorView.scrollIntoView(pos, { y: 'center' }), holdJump.of(pos)];
}

class Hold {
  pos = -1;
  started = 0;
  until = 0;
  frame = -1;

  constructor(readonly view: EditorView) {
    // On the scroller, not the content: dragging the scrollbar is the reader's too.
    for (const type of USER_EVENTS) view.scrollDOM.addEventListener(type, this.release, { passive: true });
    view.dom.addEventListener('keydown', this.release);
  }

  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      const jump = tr.effects.find((e) => e.is(holdJump));
      if (jump) {
        this.pos = jump.value as number;
        this.started = performance.now();
        this.until = this.started + HOLD_MS;
        if (this.frame < 0) this.frame = requestAnimationFrame(this.tick);
      } else if (this.pos >= 0 && tr.docChanged) {
        this.pos = tr.changes.mapPos(this.pos);
      }
    }
  }

  release = () => {
    this.pos = -1;
    if (this.frame >= 0) cancelAnimationFrame(this.frame);
    this.frame = -1;
  };

  tick = () => {
    this.frame = -1;
    const { view } = this;
    const now = performance.now();
    if (this.pos < 0 || now > this.until) { this.pos = -1; return; }
    const scroller = view.scrollDOM;
    const h = scroller.clientHeight;
    // A hidden pane (the PDF-only layout) has nothing to measure yet.
    if (h > 0) {
      const pos = Math.min(this.pos, view.state.doc.length);
      const box = scroller.getBoundingClientRect();
      const at = view.coordsAtPos(pos);
      const canUp = scroller.scrollTop > 1;
      const canDown = scroller.scrollTop + h < scroller.scrollHeight - 1;
      const off = !at
        || (at.top < box.top + h * BAND && canUp)
        || (at.bottom > box.top + h * (1 - BAND) && canDown);
      if (off) {
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
        this.until = Math.min(this.started + MAX_MS, Math.max(this.until, now + AFTER_FIX_MS));
      }
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  destroy() {
    this.release();
    for (const type of USER_EVENTS) this.view.scrollDOM.removeEventListener(type, this.release);
    this.view.dom.removeEventListener('keydown', this.release);
  }
}

/** Keeps a jump's target on screen; jumpEffects starts it, and the reader's own scrolling, click or key ends it. */
export const jumpHold = ViewPlugin.fromClass(Hold);
