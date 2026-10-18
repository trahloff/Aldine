import { describe, expect, it } from 'vitest';
import { warningKey } from '../warnings';

describe('warningKey', () => {
  it('survives the line and page moving', () => {
    expect(warningKey("Citation `knuth1984' on page 3 undefined on input line 42."))
      .toBe(warningKey("Citation `knuth1984' on page 5 undefined on input line 97."));
  });
  it('keeps the citation key, digits included', () => {
    expect(warningKey("Citation `smith2020' on page 1 undefined on input line 4."))
      .not.toBe(warningKey("Citation `smith2021' on page 1 undefined on input line 4."));
  });
  it('treats box warnings of any size alike', () => {
    expect(warningKey('Overfull \\hbox (12.3pt too wide) in paragraph at lines 40--42'))
      .toBe(warningKey('Overfull \\hbox (0.8pt too wide) in paragraph at lines 7--9'));
  });
});
