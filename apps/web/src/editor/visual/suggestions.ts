import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { setComments, CommentRange } from '../commentsEffect';

/**
 * Inline tracked changes: an unresolved review comment carrying a suggestion
 * renders as strikethrough over the original text plus the proposed
 * replacement with accept/dismiss controls — Word-style track changes over
 * LaTeX. Accepting routes through the exact same API as the Review panel.
 */
class SuggestionWidget extends WidgetType {
  constructor(readonly id: string, readonly text: string) {
    super();
  }

  eq(other: SuggestionWidget): boolean {
    return other.id === this.id && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-vis-suggest';
    el.setAttribute('data-testid', 'vis-suggest');
    const ins = document.createElement('span');
    ins.className = 'cm-vis-suggest__ins';
    ins.textContent = this.text;
    el.appendChild(ins);
    const mk = (label: string, title: string, action: 'accept' | 'resolve') => {
      const b = document.createElement('button');
      b.className = 'cm-vis-suggest__btn';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.setAttribute('data-testid', `vis-suggest-${action}`);
      // mousedown keeps the editor's selection; click (also Enter and Space
      // on a focused button) acts
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('aldine:suggestion', { detail: { id: this.id, action } }));
      };
      el.appendChild(b);
    };
    mk('✓', `Accept suggestion: ${this.text}`, 'accept');
    mk('✕', 'Dismiss suggestion', 'resolve');
    return el;
  }

  /** The buttons handle their own events; CodeMirror must not turn their Enter into a newline. */
  ignoreEvent(event: Event): boolean {
    return !!(event.target as HTMLElement | null)?.closest?.('button');
  }
}

const strike = Decoration.mark({ class: 'cm-vis-strike' });

/**
 * The review-comment ranges the pane last pushed, mapped through every edit
 * since. Lives outside the mode compartment (CodePane includes it in Source
 * mode too), so switching to Visual finds the suggestions already there.
 */
export const commentRangesField = StateField.define<CommentRange[]>({
  create: () => [],
  update(ranges, tr) {
    for (const e of tr.effects) if (e.is(setComments)) ranges = e.value;
    if (!tr.docChanged) return ranges;
    // Ranges can arrive before the Yjs doc has synced (doc still empty);
    // leave anything that doesn't fit the pre-change doc unmapped — build()
    // only renders ranges valid for the current doc, so they light up once
    // the content lands instead of crashing the changeset mapping.
    // Typing at either end stays outside, like the comment highlight's marks.
    const startLen = tr.startState.doc.length;
    return ranges.map((r) => {
      if (r.from > startLen || r.to > startLen) return r;
      const from = tr.changes.mapPos(r.from, 1);
      return { ...r, from, to: Math.max(from, tr.changes.mapPos(r.to, -1)) };
    });
  },
});

function build(ranges: CommentRange[], docLen: number): DecorationSet {
  const active = ranges
    .filter((r) => !r.resolved && r.suggestion != null && r.from < r.to && r.to <= docLen)
    .sort((a, b) => a.from - b.from);
  const decos = [];
  for (const r of active) {
    decos.push(strike.range(r.from, r.to));
    decos.push(Decoration.widget({ widget: new SuggestionWidget(r.id, r.suggestion!), side: 1 }).range(r.to));
  }
  return Decoration.set(decos, true);
}

export const suggestField = StateField.define<{ ranges: CommentRange[]; deco: DecorationSet }>({
  create(state) {
    const ranges = state.field(commentRangesField, false) ?? [];
    return { ranges, deco: build(ranges, state.doc.length) };
  },
  update(value, tr) {
    const ranges = tr.state.field(commentRangesField, false) ?? [];
    if (ranges === value.ranges) return value;
    return { ranges, deco: build(ranges, tr.state.doc.length) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
