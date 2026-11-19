import { describe, it, expect } from 'vitest';
import { leadingColumns } from '../wrapIndent';

describe('leadingColumns', () => {
  it('counts leading spaces', () => {
    expect(leadingColumns('    \\item text', 4)).toBe(4);
  });
  it('expands tabs to the next tab stop', () => {
    expect(leadingColumns('\t\\item', 4)).toBe(4);
    expect(leadingColumns('  \t\\item', 4)).toBe(4);
    expect(leadingColumns('\t \\item', 8)).toBe(9);
  });
  it('is 0 for unindented and whitespace-only lines', () => {
    expect(leadingColumns('\\section{A}', 4)).toBe(0);
    expect(leadingColumns('', 4)).toBe(0);
    expect(leadingColumns('      ', 4)).toBe(0);
  });
});
