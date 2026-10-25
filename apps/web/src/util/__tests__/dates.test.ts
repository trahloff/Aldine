import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayAgo, shortDate, subscribeMinute, timeAgo, timeSection } from '../dates';

const NOW = new Date(2026, 9, 25, 15, 30, 0).getTime(); // Sun Oct 25 2026, 15:30 local
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('timeAgo', () => {
  it('reads like a document browser', () => {
    expect(`Edited ${timeAgo(ago(20_000), NOW)}`).toBe('Edited just now');
    expect(`Edited ${timeAgo(ago(1 * MIN), NOW)}`).toBe('Edited 1 minute ago');
    expect(`Edited ${timeAgo(ago(3 * MIN + 40_000), NOW)}`).toBe('Edited 3 minutes ago');
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(timeAgo(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(timeAgo(ago(22 * DAY), NOW)).toBe('22 days ago');
  });

  it('says yesterday for the day before, and hours across midnight', () => {
    const lateYesterday = new Date(2026, 9, 24, 23, 0).getTime();
    expect(timeAgo(new Date(lateYesterday).toISOString(), new Date(2026, 9, 25, 1, 0).getTime())).toBe('2 hours ago');
    expect(timeAgo(new Date(2026, 9, 24, 9, 0).toISOString(), NOW)).toBe('yesterday');
  });

  it('gives a date past a month, with the year only when it differs', () => {
    expect(timeAgo(new Date(2026, 8, 3, 12).toISOString(), NOW)).toBe('on Sep 3');
    expect(timeAgo(new Date(2025, 2, 3, 12).toISOString(), NOW)).toBe('on Mar 3, 2025');
    expect(shortDate(new Date(2025, 10, 23).toISOString(), NOW)).toBe('Nov 23, 2025');
  });

  it('treats a clock running ahead as just now', () => {
    expect(timeAgo(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('just now');
    expect(timeAgo('not a date', NOW)).toBe('');
  });
});

describe('dayAgo', () => {
  it('names the day, for the trash', () => {
    expect(`Deleted ${dayAgo(ago(2 * HOUR), NOW)}`).toBe('Deleted today');
    expect(dayAgo(new Date(2026, 9, 24, 9).toISOString(), NOW)).toBe('yesterday');
    expect(dayAgo(ago(4 * DAY), NOW)).toBe('4 days ago');
  });
});

describe('timeSection', () => {
  it('groups by calendar day, then month, then year', () => {
    expect(timeSection(ago(3 * MIN), NOW).label).toBe('Today');
    expect(timeSection(new Date(2026, 9, 24, 8).toISOString(), NOW).label).toBe('Yesterday');
    expect(timeSection(ago(4 * DAY), NOW).label).toBe('Previous 7 days');
    expect(timeSection(ago(20 * DAY), NOW).label).toBe('Previous 30 days');
    expect(timeSection(new Date(2026, 2, 1).toISOString(), NOW)).toEqual({ key: 'm2', label: 'March' });
    expect(timeSection(new Date(2024, 2, 1).toISOString(), NOW)).toEqual({ key: 'y2024', label: '2024' });
  });
});

describe('the minute tick', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('is one timer for every subscriber, fired at the turn of the minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 15, 30, 20));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeMinute(a);
    const offB = subscribeMinute(b);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(39_000);
    expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(a).toHaveBeenCalledTimes(2);
    offA();
    offB();
    vi.advanceTimersByTime(120_000);
    expect(a).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
