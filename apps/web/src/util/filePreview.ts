import type { TreeEntry } from '../api';

/** What the editor area shows for a file instead of the code editor. */
export type PreviewKind = 'image' | 'pdf' | 'file';

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * null: the file opens in the code editor. An SVG is text to the server but
 * opens as a picture; any other file the listing marks binary gets the
 * name-size-download panel, since the editor cannot show its bytes.
 */
export function previewKind(path: string, entry?: Pick<TreeEntry, 'binary'> | null): PreviewKind | null {
  if (IMAGE.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  return entry?.binary ? 'file' : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Image scales: 1 is one image pixel per CSS pixel. */
export const IMAGE_ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
/** PDF scales: multiples of the fit-width size. */
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** The next step up or down from `current`, which need not be a step itself
 *  (fit-to-pane lands between them); clamped at either end. */
export function nextZoom(current: number, dir: 1 | -1, steps: number[]): number {
  const eps = 1e-6;
  if (dir > 0) return steps.find((s) => s > current + eps) ?? steps[steps.length - 1];
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] < current - eps) return steps[i];
  return steps[0];
}
