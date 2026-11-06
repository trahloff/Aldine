import { describe, it, expect } from 'vitest';
import { hintFor } from '../errorHints';

describe('hintFor', () => {
  it('sends an undefined citation to the line that loads the .bib, not to a sync', () => {
    const hint = hintFor("Citation 'turing1950' on page 1 undefined on input line 12.");
    expect(hint).toContain('a .bib the document loads');
    expect(hint).toContain('\\addbibresource');
    expect(hint).toContain('\\bibliography');
    expect(hint).not.toMatch(/sync/i);
  });
});
