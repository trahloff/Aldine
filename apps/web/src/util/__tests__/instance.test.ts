import { describe, expect, it } from 'vitest';
import { parseInstance, supportHref } from '../../instance';
import { documentTitle } from '../documentTitle';

describe('instance operator', () => {
  it('reads what the server stamped, and nothing it did not', () => {
    const i = parseInstance(JSON.stringify({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' } }));
    expect(i).toEqual({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' } });
    expect(supportHref(i!.support!)).toBe('mailto:it@uni-kiel.de');
    expect(parseInstance(null)).toBeNull();
    expect(parseInstance('not json')).toBeNull();
    expect(parseInstance(JSON.stringify({ name: null, logo: null, support: null }))).toBeNull();
    const hostile = parseInstance(JSON.stringify({ name: 'X', url: 'javascript:alert(1)', logo: '../x', support: { kind: 'url', value: 'javascript:alert(1)' } }));
    expect(hostile).toEqual({ name: 'X', logo: null, logoDark: null, url: null, support: null });
  });

  it('adds the operator after Aldine in the tab title, never instead', () => {
    expect(documentTitle('Projects', null)).toBe('Projects – Aldine');
    expect(documentTitle('Projects', 'Kiel University')).toBe('Projects – Aldine · Kiel University');
    expect(documentTitle(null, 'Kiel University')).toBe('Aldine · Kiel University');
  });
});
