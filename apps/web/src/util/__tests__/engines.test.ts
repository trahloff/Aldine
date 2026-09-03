import { describe, expect, it } from 'vitest';
import { engineLabel, importSummary, texliveLabel } from '../engines';

describe('texliveLabel', () => {
  it('shows release and scheme from a current compiler', () => {
    expect(texliveLabel({ ok: true, texlive: { release: '2026', scheme: 'full' } })).toBe('2026, full');
  });
  it('is honest about a compiler that predates the report', () => {
    expect(texliveLabel({ ok: true, texlive: { release: 'unknown', scheme: 'unknown' } })).toBe('Not reported by this compiler');
  });
  it('shows what it has when only one half is known', () => {
    expect(texliveLabel({ ok: true, texlive: { release: '2026', scheme: 'unknown' } })).toBe('2026');
    expect(texliveLabel({ ok: true, texlive: { release: 'unknown', scheme: 'medium' } })).toBe('unknown release, medium');
  });
  it('distinguishes unreachable from not yet loaded', () => {
    expect(texliveLabel({ ok: false, texlive: { release: 'unknown', scheme: 'unknown' } })).toBe('Compiler not reachable');
    expect(texliveLabel(null)).toBe('Checking the compiler');
  });
});

describe('importSummary', () => {
  it('names the detected engine and its source', () => {
    expect(importSummary({ name: 'thesis', import: { engine: 'xelatex', engineReason: 'latexmkrc in the archive', transcoded: [] } }))
      .toBe('Imported thesis: XeLaTeX (latexmkrc in the archive)');
  });
  it('states the default when nothing asked for another engine', () => {
    expect(importSummary({ name: 'notes', import: { engine: 'pdf', engineReason: null, transcoded: [] } }))
      .toBe('Imported notes: pdfLaTeX');
  });
  it('names transcoded files without guessing their encoding', () => {
    expect(importSummary({ name: 'old', import: { engine: 'pdf', engineReason: null, transcoded: ['main.tex'] } }))
      .toBe('Imported old: pdfLaTeX. main.tex was not UTF-8 and has been transcoded');
    expect(importSummary({ name: 'old', import: { engine: 'pdf', engineReason: null, transcoded: ['a.tex', 'b.tex'] } }))
      .toContain('2 files were not UTF-8 and have been transcoded');
  });
  it('falls back to the id for an engine it does not know', () => {
    expect(engineLabel('tectonic')).toBe('tectonic');
  });
});
