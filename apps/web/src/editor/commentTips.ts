import { StateEffect, StateField, type EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import type { CommentRange } from './commentsEffect';
import { commentRangesField } from './visual/suggestions';

/**
 * Commented text shows its comment: on hover, and while the caret is in it
 * (a click, or the keyboard). Typing in the text puts the caret's card away
 * until the caret leaves the comment, and Escape does too. Selection and
 * tooltips only: the document is never touched.
 */

/** The comments whose text holds `pos`, the shortest (innermost) first. */
export function commentsAt(ranges: readonly CommentRange[], pos: number, docLen: number): CommentRange[] {
  return ranges
    .filter((r) => r.from < r.to && r.to <= docLen && r.from <= pos && pos < r.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from));
}

/** The comment the caret is in, or null. A selection is no caret, except,
 *  with `exact`, one that is a comment's whole text (Review's reveal). */
export function commentAtCaret(state: EditorState, exact = false): string | null {
  const sel = state.selection.main;
  const ranges = state.field(commentRangesField, false) ?? [];
  if (!sel.empty) return exact ? ranges.find((r) => r.from === sel.from && r.to === sel.to)?.id ?? null : null;
  return commentsAt(ranges, sel.head, state.doc.length)[0]?.id ?? null;
}

interface CaretTip { open: string | null; dismissed: string | null }

const closeTip = StateEffect.define<null>();

const typed = (tr: Transaction) => tr.docChanged && ['input', 'delete', 'undo', 'redo', 'move'].some((e) => tr.isUserEvent(e));

const caretTip = StateField.define<CaretTip>({
  create: () => ({ open: null, dismissed: null }),
  update(value, tr) {
    const at = commentAtCaret(tr.state);
    if (tr.effects.some((e) => e.is(closeTip)) || typed(tr)) return { open: null, dismissed: at };
    if (!tr.selection && !tr.docChanged && !tr.effects.length) return value;
    const dismissed = at && at === value.dismissed ? at : null;
    return { open: at && at !== dismissed ? at : null, dismissed };
  },
});

/** What a card says about one comment. */
function card(r: CommentRange, onOpen: (id: string) => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cm-comment-tip__item';
  box.dataset.commentId = r.id;
  const head = document.createElement('div');
  head.className = 'cm-comment-tip__head';
  const who = document.createElement('strong');
  who.textContent = r.author || 'Comment';
  head.append(who);
  const extra = [r.resolved ? 'Resolved' : '', r.replies ? `${r.replies} ${r.replies === 1 ? 'reply' : 'replies'}` : ''].filter(Boolean).join(' · ');
  if (extra) head.append(` · ${extra}`);
  box.append(head);
  if (r.body) {
    const body = document.createElement('div');
    body.className = 'cm-comment-tip__body';
    body.textContent = r.body;
    box.append(body);
  }
  if (r.suggestion !== undefined) {
    const sugg = document.createElement('div');
    sugg.className = 'cm-comment-tip__suggestion';
    sugg.textContent = r.suggestion ? `Suggests: ${r.suggestion}` : 'Suggests deleting this text';
    box.append(sugg);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn--small cm-comment-tip__open';
  open.textContent = 'Open in Review';
  open.dataset.testid = 'comment-tip-open';
  // mousedown would move the caret out of the comment before the click lands
  open.addEventListener('mousedown', (e) => e.preventDefault());
  open.addEventListener('click', () => onOpen(r.id));
  box.append(open);
  return box;
}

function tooltipFor(list: CommentRange[], onOpen: (id: string) => void, testId: string): Tooltip {
  const first = list[0];
  return {
    pos: first.from,
    end: first.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-comment-tip';
      dom.dataset.testid = testId;
      for (const r of list.slice(0, 3)) dom.append(card(r, onOpen));
      return { dom };
    },
  };
}

/**
 * `onOpen`: the person asked for a comment's thread in Review. `onCaret`: the
 * comment the caret is in changed (null: none), so Review can mark its card.
 */
export function commentTips(onOpen: (id: string) => void, onCaret: (id: string | null) => void): Extension {
  let lastCaret: string | null = null;
  return [
    caretTip,
    showTooltip.compute([caretTip, commentRangesField], (state) => {
      const { open } = state.field(caretTip);
      if (!open) return null;
      const ranges = state.field(commentRangesField, false) ?? [];
      const list = commentsAt(ranges, state.selection.main.head, state.doc.length);
      return list.length ? tooltipFor(list, onOpen, 'comment-tip') : null;
    }),
    hoverTooltip((view, pos, side) => {
      const ranges = view.state.field(commentRangesField, false) ?? [];
      // the character on the hovered side of `pos`
      const list = commentsAt(ranges, side < 0 ? pos - 1 : pos, view.state.doc.length);
      if (!list.length || view.state.field(caretTip).open === list[0].id) return null;
      return tooltipFor(list, onOpen, 'comment-hover');
    }, { hoverTime: 250 }),
    keymap.of([{
      key: 'Escape',
      run: (view) => {
        if (!view.state.field(caretTip).open) return false;
        view.dispatch({ effects: closeTip.of(null) });
        return true;
      },
    }]),
    EditorView.updateListener.of((u) => {
      const at = commentAtCaret(u.state, true);
      if (at !== lastCaret) { lastCaret = at; onCaret(at); }
    }),
  ];
}
