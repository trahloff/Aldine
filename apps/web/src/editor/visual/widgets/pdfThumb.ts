/**
 * Page 1 of a PDF figure as an image URL, drawn by the pdf.js the PDF pane
 * already ships. One render per file URL per page load.
 */
const cache = new Map<string, Promise<string | null>>();

/** Tall enough for the 140 px preview at 2x. */
const TARGET_HEIGHT = 280;

export function pdfThumbnail(url: string): Promise<string | null> {
  let hit = cache.get(url);
  if (!hit) {
    hit = render(url).catch(() => null);
    cache.set(url, hit);
  }
  return hit;
}

async function render(url: string): Promise<string | null> {
  const { pdfjs } = await import('../../../util/pdfjs');
  const doc = await pdfjs.getDocument({ url }).promise;
  try {
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, TARGET_HEIGHT / natural.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    void doc.destroy();
  }
}
