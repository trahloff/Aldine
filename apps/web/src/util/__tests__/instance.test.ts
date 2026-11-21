import { describe, expect, it } from 'vitest';
import { legalLinks, parseInstance, supportHref } from '../../instance';
import { documentTitle } from '../documentTitle';

describe('instance operator', () => {
  it('reads what the server stamped, and nothing it did not', () => {
    const i = parseInstance(JSON.stringify({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' } }));
    expect(i).toEqual({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' }, privacy: null, legal: null, terms: null });
    expect(supportHref(i!.support!)).toBe('mailto:it@uni-kiel.de');
    expect(parseInstance(null)).toBeNull();
    expect(parseInstance('not json')).toBeNull();
    expect(parseInstance(JSON.stringify({ name: null, logo: null, support: null }))).toBeNull();
    const hostile = parseInstance(JSON.stringify({ name: 'X', url: 'javascript:alert(1)', logo: '../x', support: { kind: 'url', value: 'javascript:alert(1)' } }));
    expect(hostile).toEqual({ name: 'X', logo: null, logoDark: null, url: null, support: null, privacy: null, legal: null, terms: null });
  });

  it('reads the privacy, legal notice and terms links, which alone are enough to show', () => {
    const i = parseInstance(JSON.stringify({ privacy: 'https://example.org/privacy', legal: 'https://example.org/impressum', terms: 'javascript:alert(1)' }));
    expect(i).toMatchObject({ name: null, privacy: 'https://example.org/privacy', legal: 'https://example.org/impressum', terms: null });
    expect(legalLinks(i)).toEqual([
      { id: 'privacy', label: 'Privacy policy', href: 'https://example.org/privacy' },
      { id: 'legal', label: 'Legal notice', href: 'https://example.org/impressum' },
    ]);
    expect(legalLinks(null)).toEqual([]);
    expect(parseInstance(JSON.stringify({ terms: 'https://example.org/terms' }))?.terms).toBe('https://example.org/terms');
  });

  it('adds the operator after Aldine in the tab title, never instead', () => {
    expect(documentTitle('Projects', null)).toBe('Projects – Aldine');
    expect(documentTitle('Projects', 'Kiel University')).toBe('Projects – Aldine · Kiel University');
    expect(documentTitle(null, 'Kiel University')).toBe('Aldine · Kiel University');
  });
});
