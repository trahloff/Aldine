import { WidgetType } from '@codemirror/view';
import { citeLabel, figureFile, fileUrl } from '../context';
import { pdfThumbnail } from './pdfThumb';

/** What a screen reader says for each chip kind, before the label. */
const SPOKEN: Record<string, string> = { cite: 'Citation', ref: 'Reference', table: 'Table' };

/** Text only assistive technology reads (the visual tag is styled, not spoken). */
function spoken(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-vis-sr';
  el.textContent = text;
  return el;
}

/** A compact pill standing in for a construct; click puts the caret inside. */
class Chip extends WidgetType {
  constructor(readonly kind: string, readonly label: string) {
    super();
  }

  eq(other: Chip): boolean {
    return other.kind === this.kind && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-vis-chip cm-vis-chip--${this.kind}`;
    el.setAttribute('data-testid', `vis-chip-${this.kind}`);
    el.appendChild(spoken(`${SPOKEN[this.kind] ?? this.kind}: `));
    const tag = document.createElement('span');
    tag.className = 'cm-vis-chip__kind';
    tag.textContent = this.kind;
    tag.setAttribute('aria-hidden', 'true');
    el.appendChild(tag);
    if (this.label) el.appendChild(document.createTextNode(this.label));
    return el;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/** Figure with an inline preview when the included graphic exists in the project. */
class FigureWidget extends WidgetType {
  /** `file`: the project path the graphic resolved to, or null. */
  constructor(readonly caption: string, readonly file: string | null) {
    super();
  }

  eq(other: FigureWidget): boolean {
    return other.caption === this.caption && other.file === this.file;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-vis-chip cm-vis-figure';
    el.setAttribute('data-testid', 'vis-chip-figure');
    const url = this.file ? fileUrl(this.file) : null;
    if (this.file && url) {
      const img = document.createElement('img');
      // the caption shown beside the image is its text alternative
      img.alt = this.caption ? '' : this.file;
      img.className = 'cm-vis-figure__img';
      img.setAttribute('data-testid', 'vis-figure-img');
      if (/\.pdf$/i.test(this.file)) {
        // an <img> can't show a PDF: page 1 is drawn by pdf.js
        img.hidden = true;
        pdfThumbnail(url).then((src) => {
          if (!src) return img.remove();
          img.src = src;
          img.hidden = false;
        });
      } else {
        img.src = url;
        img.onerror = () => img.remove();
      }
      el.appendChild(img);
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

export function figureChip(caption: string, image: string | null = null): FigureWidget {
  return new FigureWidget(caption, image ? figureFile(image) : null);
}
export function tableChip(caption: string): Chip {
  return new Chip('table', caption);
}

/**
 * `notes` are the optional arguments as written: one is a postnote
 * (\cite[p.~12]{k}), two are prenote and postnote (\cite[see][ch.~3]{k}).
 */
export function citeChip(keys: string, notes: string[] = []): Chip {
  const tidy = (s: string) => s.replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
  const [pre, post] = notes.length >= 2 ? [tidy(notes[0]), tidy(notes[1])] : ['', tidy(notes[0] ?? '')];
  const label = [pre, citeLabel(keys) ?? keys].filter(Boolean).join(' ');
  return new Chip('cite', post ? `${label}, ${post}` : label);
}
export function refChip(target: string): Chip {
  return new Chip('ref', target);
}
