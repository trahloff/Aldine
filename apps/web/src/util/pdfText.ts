import type { TextRange } from './pdfFind';

/**
 * The page text layers of the PDF preview (pdf.js's TextLayer): what keeps a
 * selection over them sane, and Find's marks in them.
 */

/** A drawn text layer: its span for each text item, that item's string, and
 *  the items Find has marked. */
export interface TextSpans { divs: HTMLElement[]; strs: string[]; marked: Set<number> }

/** A match to mark: its spans of the items, and whether it is the one Find is on. */
export interface Hit { ranges: readonly TextRange[]; current: boolean }

/**
 * Wraps each hit's part of each span in a mark, after giving back their text
 * to the spans marked before. A span's string never changes, so its width
 * (pdf.js scales each span to its glyphs) stays right.
 */
export function markHits(spans: TextSpans, hits: readonly Hit[]): void {
  for (const k of spans.marked) spans.divs[k].textContent = spans.strs[k];
  spans.marked.clear();
  const parts = new Map<number, { from: number; to: number; current: boolean }[]>();
  for (const h of hits) {
    for (const r of h.ranges) {
      let list = parts.get(r.item);
      if (!list) parts.set(r.item, (list = []));
      list.push({ from: r.from, to: r.to, current: h.current });
    }
  }
  for (const [k, list] of parts) {
    const div = spans.divs[k], str = spans.strs[k];
    if (!div || str == null) continue;
    list.sort((a, b) => a.from - b.from);
    const nodes: Node[] = [];
    let at = 0;
    for (const p of list) {
      if (p.from < at || p.to <= p.from) continue;
      if (p.from > at) nodes.push(document.createTextNode(str.slice(at, p.from)));
      const mark = document.createElement('mark');
      mark.className = p.current ? 'pdf-hit pdf-hit--current' : 'pdf-hit';
      mark.dataset.testid = 'pdf-find-hit';
      mark.textContent = str.slice(p.from, p.to);
      nodes.push(mark);
      at = p.to;
    }
    if (at < str.length) nodes.push(document.createTextNode(str.slice(at)));
    div.replaceChildren(...nodes);
    spans.marked.add(k);
  }
}

/** Text layers that take part in selecting, each with its end block. */
const layers = new Map<HTMLElement, HTMLElement>();
let listening: AbortController | null = null;

/**
 * Lets a selection be made over `layer` as in pdf.js's own viewer
 * (TextLayerBuilder): the layer ends in a block that, while a selection is
 * made over the layer, covers the page beneath its text. A drag across the
 * gap between two lines then extends the selection to the line under the
 * pointer, not to the end of the layer. Chromium also needs the block moved
 * to just past the selection's moving end.
 */
export function bindSelection(layer: HTMLElement): void {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  layers.set(layer, end);
  listen();
}

export function unbindSelection(layer: HTMLElement): void {
  layers.delete(layer);
  if (!layers.size) {
    listening?.abort();
    listening = null;
  }
}

// Runs on every selection change in the app, the editor's caret moves too:
// a layer that is already reset is left untouched.
function reset(end: HTMLElement, layer: HTMLElement) {
  if (layer.lastChild !== end) layer.append(end);
  if (end.style.width || end.style.height) {
    end.style.width = '';
    end.style.height = '';
  }
  if (layer.classList.contains('selecting')) layer.classList.remove('selecting');
}

function listen() {
  if (listening) return;
  listening = new AbortController();
  const { signal } = listening;
  let down = false;
  let prev: Range | null = null;
  // Firefox selects across the gaps by itself.
  const gecko = typeof CSS !== 'undefined' && CSS.supports('-moz-appearance', 'none');
  const resetAll = () => layers.forEach(reset);
  document.addEventListener('pointerdown', () => { down = true; }, { signal });
  document.addEventListener('pointerup', () => { down = false; resetAll(); }, { signal });
  window.addEventListener('blur', () => { down = false; resetAll(); }, { signal });
  document.addEventListener('keyup', () => { if (!down) resetAll(); }, { signal });
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) { resetAll(); return; }
    const active = new Set<HTMLElement>();
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of layers) {
      if (!active.has(layer)) reset(end, layer);
      else if (!layer.classList.contains('selecting')) layer.classList.add('selecting');
    }
    if (gecko || !active.size) { prev = null; return; }
    const range = sel.getRangeAt(0);
    const startMoved = !!prev && (range.compareBoundaryPoints(Range.END_TO_END, prev) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prev) === 0);
    const node = startMoved ? range.startContainer : range.endContainer;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof Element ? node : null;
    // The item's span itself, also when the end is inside one of Find's marks.
    const span = el?.closest<HTMLElement>('.pdf-text > span');
    const layer = span?.parentElement;
    const end = layer && layers.get(layer);
    if (span && layer && end) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      layer.insertBefore(end, startMoved ? span : span.nextSibling);
    }
    prev = range.cloneRange();
  }, { signal });
}
