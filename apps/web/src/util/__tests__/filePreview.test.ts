import { describe, it, expect } from 'vitest';
import { formatBytes, IMAGE_ZOOM_STEPS, nextZoom, PDF_ZOOM_STEPS, previewKind } from '../filePreview';

describe('previewKind', () => {
  it('shows images and PDFs as previews, whatever the case of the extension', () => {
    for (const p of ['fig.png', 'a/b/photo.JPG', 'x.jpeg', 'anim.gif', 'shot.webp', 'diagram.svg']) expect(previewKind(p)).toBe('image');
    expect(previewKind('supplement.PDF', { binary: true })).toBe('pdf');
  });

  it('opens an SVG as a picture although the listing calls it text', () => {
    expect(previewKind('plot.svg', { binary: false })).toBe('image');
  });

  it('gives other binary files the download panel and leaves text to the editor', () => {
    expect(previewKind('data.zip', { binary: true })).toBe('file');
    expect(previewKind('figure.eps', { binary: true })).toBe('file');
    expect(previewKind('main.tex', { binary: false })).toBeNull();
    expect(previewKind('refs.bib')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('counts bytes below a kilobyte and rounds above', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1023 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.25 * 1024 * 1024)).toBe('3.3 MB');
  });
});

describe('nextZoom', () => {
  it('steps from a scale between steps to the neighbouring ones', () => {
    expect(nextZoom(0.42, 1, IMAGE_ZOOM_STEPS)).toBe(0.5);
    expect(nextZoom(0.42, -1, IMAGE_ZOOM_STEPS)).toBe(0.25);
  });

  it('moves off a step it is on, and stops at either end', () => {
    expect(nextZoom(1, 1, PDF_ZOOM_STEPS)).toBe(1.25);
    expect(nextZoom(1, -1, PDF_ZOOM_STEPS)).toBe(0.75);
    expect(nextZoom(3, 1, PDF_ZOOM_STEPS)).toBe(3);
    expect(nextZoom(0.5, -1, PDF_ZOOM_STEPS)).toBe(0.5);
    expect(nextZoom(0.01, -1, IMAGE_ZOOM_STEPS)).toBe(0.1);
  });
});
