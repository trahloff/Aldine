import { describe, it, expect } from 'vitest';
import { outputFileName, outputSibling } from '../outputFiles';

const pdf = '/aldine/api/projects/p1/output?branch=rev%2F2&path=paper%2F.aldine-out%2Fmain.pdf&t=42';

describe('outputSibling', () => {
  it('names the file beside the PDF on the same route, branch and base path, without the PDF’s cache-buster', () => {
    const bbl = outputSibling(pdf, '.bbl')!;
    expect(bbl.name).toBe('main.bbl');
    const u = new URL(bbl.url, 'http://x');
    expect(u.pathname).toBe('/aldine/api/projects/p1/output');
    expect(u.searchParams.get('branch')).toBe('rev/2');
    expect(u.searchParams.get('path')).toBe('paper/.aldine-out/main.bbl');
    expect(u.searchParams.has('t')).toBe(false);
  });

  it('has nothing to offer for a link that names no PDF', () => {
    expect(outputSibling('/api/projects/p1/output?path=.aldine-out%2Fmain.log', '.bbl')).toBeNull();
    expect(outputSibling('/api/projects/p1/archive?branch=main', '.bbl')).toBeNull();
  });
});

describe('outputFileName', () => {
  it('is the last segment of the served path', () => {
    expect(outputFileName(pdf)).toBe('main.pdf');
    expect(outputFileName('/api/projects/p1/output?branch=main')).toBeNull();
  });
});
