import { useSyncExternalStore } from 'react';

/** macOS-style dates: "Today, 11:55 PM" / "Jul 7, 2026". */

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function friendlyDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${timeFmt.format(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The sentences around these ("Edited …", "gone …") are English, so the
// phrases inside them are too.
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
// "3 min. ago" in ICU; the periods go, as in "3 min ago".
const rtfShort = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
const shortRel = (n: number, unit: Intl.RelativeTimeFormatUnit) => rtfShort.format(n, unit).replace(/\./g, '');
const monthDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monthName = new Intl.DateTimeFormat('en', { month: 'long' });

/** Midnight at the start of `t`'s day, local time. */
function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days from `t` to `now`: 0 today, 1 yesterday. */
function daysAgo(t: number, now: number): number {
  return Math.round((dayStart(now) - dayStart(t)) / DAY);
}

/** "Oct 3", or "Oct 3, 2025" outside the current year. */
export function shortDate(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  return (d.getFullYear() === new Date(now).getFullYear() ? monthDay : monthDayYear).format(d);
}

/**
 * How long ago, the way a document browser says it: "just now", "3 minutes
 * ago", "5 hours ago", "yesterday", "4 days ago", up to "29 days ago", and a
 * date after that ("on Sep 3"). A time in the future (a clock that runs
 * ahead) reads "just now".
 */
export function timeAgo(iso: string, now: number = Date.now(), { short = false }: { short?: boolean } = {}): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const rel = short ? shortRel : (n: number, unit: Intl.RelativeTimeFormatUnit) => rtf.format(n, unit);
  const diff = Math.max(0, now - t);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return rel(-Math.floor(diff / MINUTE), 'minute');
  const days = daysAgo(t, now);
  if (days === 0 || diff < 6 * HOUR) return rel(-Math.floor(diff / HOUR), 'hour');
  if (days < 30) return rel(-days, 'day');
  return `on ${shortDate(iso, now)}`;
}

/** "today", "yesterday", "4 days ago", "on Sep 3": a day, not a time. */
export function dayAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, daysAgo(t, now));
  if (days < 30) return rtf.format(-days, 'day');
  return `on ${shortDate(iso, now)}`;
}

/** The time a project's list sections group it by. */
export interface TimeSection { key: string; label: string }

/** Today · Yesterday · Previous 7 days · Previous 30 days · a month of this year · a year. */
export function timeSection(iso: string, now: number = Date.now()): TimeSection {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { key: 'older', label: 'Older' };
  const days = daysAgo(t, now);
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days < 7) return { key: '7d', label: 'Previous 7 days' };
  if (days < 30) return { key: '30d', label: 'Previous 30 days' };
  const d = new Date(t);
  if (d.getFullYear() === new Date(now).getFullYear()) return { key: `m${d.getMonth()}`, label: monthName.format(d) };
  return { key: `y${d.getFullYear()}`, label: String(d.getFullYear()) };
}

// One clock for every relative time on the page: a single timer fires at
// the turn of each minute while anything shows a relative time.
const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTick() {
  tickTimer = setTimeout(() => {
    tickNow = Date.now();
    tickListeners.forEach((l) => l());
    scheduleTick();
  }, MINUTE - (Date.now() % MINUTE) + 50);
}

export function subscribeMinute(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickListeners.size === 1) { tickNow = Date.now(); scheduleTick(); }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) { clearTimeout(tickTimer); tickTimer = null; }
  };
}

/** Now, as of the last turn of the minute: what relative times are measured from. */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribeMinute, () => tickNow, () => tickNow);
}
