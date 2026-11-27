import type { PDFDocumentProxy } from 'pdfjs-dist';
import { safeLinkUrl } from '../util/pdfLinks';

export type PdfOutlineItem = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number];

type Props = {
  items: PdfOutlineItem[];
  onNavigate(dest: NonNullable<PdfOutlineItem['dest']>): void;
  onClose(): void;
};

function Entries({ items, onNavigate }: Pick<Props, 'items' | 'onNavigate'>) {
  return (
    <ol className="pdf-outline__list">
      {items.map((item, index) => {
        const title = item.title.trim() || 'Untitled bookmark';
        const dest = item.dest;
        const url = safeLinkUrl(item.url);
        const children = item.items ?? [];
        return (
          <li className="pdf-outline__row" key={`${index}-${title}`}>
            {dest != null ? (
              <button
                type="button"
                className="pdf-outline__entry"
                title={title}
                aria-label={`Go to ${title}`}
                data-testid="pdf-outline-item"
                onClick={() => onNavigate(dest)}
              >
                {title}
              </button>
            ) : url ? (
              <a
                className="pdf-outline__entry"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={title}
                data-testid="pdf-outline-item"
              >
                {title}
              </a>
            ) : (
              <span className="pdf-outline__entry pdf-outline__entry--label" title={title}>
                {title}
              </span>
            )}
            {children.length > 0 && <Entries items={children} onNavigate={onNavigate} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function PdfOutline({ items, onNavigate, onClose }: Props) {
  return (
    <aside
      id="pdf-outline"
      className="pdf-outline"
      aria-label="PDF bookmarks"
      data-testid="pdf-outline"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="pdf-outline__header">
        <span className="pdf-outline__title">PDF bookmarks</span>
        <button
          type="button"
          className="pdf-outline__close"
          aria-label="Close PDF bookmarks"
          title="Close PDF bookmarks"
          data-testid="pdf-outline-close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <nav className="pdf-outline__tree" aria-label="Bookmark navigation">
        <Entries items={items} onNavigate={onNavigate} />
      </nav>
    </aside>
  );
}
