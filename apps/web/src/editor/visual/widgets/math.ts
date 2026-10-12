import { WidgetType } from '@codemirror/view';
import { katexReady, renderMath } from '../katex';

/**
 * Rendered math. Clicking places the caret inside the construct (the widget's
 * host extension handles the mousedown), which reveals the raw source.
 */
export class MathWidget extends WidgetType {
  /** Whether KaTeX was there when this widget was made. A widget made before
   *  it arrived drew raw source and must not count as equal to one made after. */
  readonly ready = katexReady();

  constructor(readonly source: string, readonly display: boolean, readonly pos: number, readonly innerFrom: number, readonly innerTo: number) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.source === this.source && other.display === this.display && other.ready === this.ready;
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `cm-vis-math ${this.display ? 'cm-vis-math--display' : ''}`;
    el.dataset.pos = String(this.pos);
    el.dataset.innerFrom = String(this.innerFrom);
    el.dataset.innerTo = String(this.innerTo);
    el.setAttribute('data-testid', 'vis-math');
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
