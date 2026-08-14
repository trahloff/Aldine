import { WidgetType } from '@codemirror/view';
import { citeLabel, fileUrl, projectFileUrl } from '../context';

/** A compact pill standing in for a construct; click puts the caret inside. */
class Chip extends WidgetType {
  constructor(readonly kind: string, readonly label: string, readonly pos: number) {
    super();
  }

  eq(other: Chip): boolean {
    return other.kind === this.kind && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-vis-chip cm-vis-chip--${this.kind}`;
    el.dataset.pos = String(this.pos);
    el.setAttribute('data-testid', `vis-chip-${this.kind}`);
    const tag = document.createElement('span');
    tag.className = 'cm-vis-chip__kind';
    tag.textContent = this.kind;
    el.appendChild(tag);
    if (this.label) el.appendChild(document.createTextNode(this.label));
    return el;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/** Figure with an inline image preview when the included graphic resolves. */
class FigureWidget extends WidgetType {
  constructor(readonly caption: string, readonly image: string | null, readonly pos: number) {
    super();
  }

  eq(other: FigureWidget): boolean {
    return other.caption === this.caption && other.image === this.image;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-vis-chip cm-vis-figure';
    el.dataset.pos = String(this.pos);
    el.setAttribute('data-testid', 'vis-chip-figure');
    if (this.image) {
      const url = fileUrl(this.image);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = this.caption || this.image;
        img.className = 'cm-vis-figure__img';
        // root-dir-relative miss → retry from the project root (some projects
        // write \includegraphics paths that way), then give up quietly
        const fallback = projectFileUrl(this.image);
        img.onerror = () => {
          if (fallback && img.src !== new URL(fallback, location.href).href) img.src = fallback;
          else img.remove();
        };
        el.appendChild(img);
      }
    }
    const cap = document.createElement('span');
    cap.className = 'cm-vis-figure__cap';
    cap.textContent = this.caption ? `Figure: ${this.caption}` : 'Figure';
    el.appendChild(cap);
    return el;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

export function figureChip(caption: string, pos: number, image: string | null = null): FigureWidget {
  return new FigureWidget(caption, image, pos);
}
export function tableChip(caption: string, pos: number): Chip {
  return new Chip('table', caption, pos);
}
export function citeChip(keys: string, pos: number): Chip {
  return new Chip('cite', citeLabel(keys) ?? keys, pos);
}
export function refChip(target: string, pos: number): Chip {
  return new Chip('ref', target, pos);
}
