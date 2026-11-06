import { describe, it, expect } from 'vitest';
import { stepsBack } from '../leaveGuard';

describe('stepsBack', () => {
  it('undoes a Back with a step forward and a Forward with a step back', () => {
    expect(stepsBack(5, 4)).toBe(1);
    expect(stepsBack(5, 2)).toBe(3);
    expect(stepsBack(5, 6)).toBe(-1);
  });

  it('gives up on entries the router did not number, and on no move at all', () => {
    expect(stepsBack(undefined, 4)).toBeNull();
    expect(stepsBack(5, null)).toBeNull();
    expect(stepsBack(5, 5)).toBeNull();
  });
});
