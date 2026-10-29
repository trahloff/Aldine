import * as pdfjs from 'pdfjs-dist';

/**
 * pdf.js with its worker set: every PDF this app draws (the typeset pane, the
 * file preview, Visual's figure thumbnails) goes through this module, so the
 * worker URL is set in one place and before any getDocument.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// Resolved from workerSrc, not document.baseURI: on a project route like
// /p/<id> the document URL would point cmaps at /p/cmaps/, which the SPA
// fallback answers with 200 + index.html and pdf.js silently renders blanks.
// One level up from the worker is right in both modes: the build emits the
// cmaps at <base>/cmaps/ (vite.config.ts) next to the worker's assets/, and
// dev's workerSrc is the package's own build/ dir under /@fs, so ../cmaps/
// is the shipped pdfjs-dist cmaps — no dev middleware needed.
export const cMapUrl = new URL('../cmaps/', pdfjs.GlobalWorkerOptions.workerSrc).toString();

export { pdfjs };
