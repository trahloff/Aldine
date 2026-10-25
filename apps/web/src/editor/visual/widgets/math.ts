import { WidgetType } from '@codemirror/view';
import { katexReady, renderMath } from '../katex';
import { mathliveCanEdit } from '../mathPopover';
import { shortcut } from '../../../platform';

/** What a rendered formula stands for, relative to the construct's start. */
export interface MathSpan { raw: string; innerStart: number; innerEnd: number }

/** Math widget DOM → its construct, for the click handler (index.ts). */
export const mathSpans = new WeakMap<HTMLElement, MathSpan>();

/**
 * Rendered math. A click opens the formula editor on the construct at the
 * widget's position when the click happens (the host extension handles it).
 */
export class MathWidget extends WidgetType {
  /** Whether KaTeX was there when this widget was made. A widget made before
   *  it arrived drew raw source and must not count as equal to one made after. */
  readonly ready = katexReady();

  /** `raw` is the whole construct: equal raw means equal inner offsets, so a
   *  widget kept across edits elsewhere still describes its construct. */
  constructor(readonly source: string, readonly display: boolean, readonly raw: string, readonly innerStart: number, readonly innerEnd: number) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.raw === this.raw && other.display === this.display && other.ready === this.ready;
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `cm-vis-math ${this.display ? 'cm-vis-math--display' : ''}`;
    el.setAttribute('data-testid', 'vis-math');
    el.title = mathliveCanEdit(this.raw.slice(this.innerStart, this.innerEnd))
      ? `Edit formula (${shortcut('Enter')} in its source)`
      : 'Edit in the source: the formula editor would rewrite its \\label, alignment, comments or line breaks';
    mathSpans.set(el, { raw: this.raw, innerStart: this.innerStart, innerEnd: this.innerEnd });
    const html = renderMath(this.source, this.display);
    if (html) {
      el.innerHTML = html;
    } else {
      // loading or render failure: show the raw source, honestly
      el.classList.add('cm-vis-math--raw');
      el.textContent = this.source;
    }
    return el;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}
