import { WidgetType } from '@codemirror/view';
import { UNDRAWN_COLOR, katexReady, renderMath } from '../katex';
import { mathliveBlocker } from '../mathPopover';
import { macrosUsedBy } from '../preamble';
import type { MacroSet } from '../preamble';
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
  /** Only the macros this formula uses, so editing another one's definition leaves it as drawn. */
  readonly macros: MacroSet;

  constructor(readonly source: string, readonly display: boolean, readonly raw: string, readonly innerStart: number, readonly innerEnd: number, macros: MacroSet) {
    super();
    this.macros = macrosUsedBy(source, macros);
  }

  eq(other: MathWidget): boolean {
    return other.raw === this.raw && other.display === this.display && other.ready === this.ready && other.macros.key === this.macros.key;
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `cm-vis-math ${this.display ? 'cm-vis-math--display' : ''}`;
    el.setAttribute('data-testid', 'vis-math');
    el.title = mathliveBlocker(this.raw.slice(this.innerStart, this.innerEnd)) ?? `Edit formula (${shortcut('Enter')} in its source)`;
    mathSpans.set(el, { raw: this.raw, innerStart: this.innerStart, innerEnd: this.innerEnd });
    const html = renderMath(this.source, this.display, this.macros);
    if (html) {
      el.innerHTML = html;
      const issue = drawIssue(html, el.querySelector('.katex-error')?.getAttribute('title') ?? null);
      if (issue) el.title = issue;
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

/**
 * What KaTeX could not draw, said plainly, or null. A command defined
 * nowhere the editor reads is drawn as its name in the muted error colour;
 * a formula it cannot parse at all is an error span with KaTeX's message.
 */
export function drawIssue(html: string, errorTitle: string | null): string | null {
  const marked = `mathcolor="${UNDRAWN_COLOR}"><mtext>`;
  const unknown = [...new Set(html.split(marked).slice(1).map((part) => /^\\[A-Za-z@]+/.exec(part)?.[0]).filter((c): c is string => !!c))];
  if (unknown.length) return `Can't draw ${unknown.join(', ')}: not defined in the preamble or in the files it inputs, so shown as written.`;
  if (errorTitle === null) return null;
  const reason = errorTitle.replace(/^ParseError: KaTeX parse error: /, '').replace(/ at position \d+:[\s\S]*$/, '');
  return `Can't draw this formula${reason ? `: ${reason}` : ''}. It shows as its source.`;
}
