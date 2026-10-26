import { WidgetType } from '@codemirror/view';

/** The character an escape such as `\%` or `\ldots` typesets as. */
export class SymbolWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: SymbolWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-vis-sym';
    el.setAttribute('data-testid', 'vis-sym');
    el.textContent = this.text;
    return el;
  }
}
