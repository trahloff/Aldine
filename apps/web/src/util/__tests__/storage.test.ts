import { describe, expect, it } from 'vitest';
import { formatMb, storageLine } from '../storage';

const MB = 1024 * 1024;

describe('storage figures', () => {
  it('one decimal below 10 MB, whole numbers above', () => {
    expect(formatMb(0)).toBe('0 MB');
    expect(formatMb(1)).toBe('0.1 MB');
    expect(formatMb(7.54 * MB)).toBe('7.5 MB');
    expect(formatMb(1 * MB)).toBe('1 MB');
    expect(formatMb(512.4 * MB)).toBe('512 MB');
  });
  it('names the limit when there is one', () => {
    expect(storageLine(120 * MB, 500 * MB)).toBe('120 MB of 500 MB');
    expect(storageLine(120 * MB, 0)).toBe('120 MB');
  });
});
