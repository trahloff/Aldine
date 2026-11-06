import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useDialogs } from '../components/Dialogs';

/** The question before leaving a page whose edits are not all on the server. */
export const LEAVE_UNSAVED = { title: 'Some edits aren’t saved yet. Leave anyway?', confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true };

/** How far to move through the history to get back from the entry with index
 *  `to` to the one with index `from` (the router keeps `idx` in each entry's
 *  state); null when either is unknown. */
export function stepsBack(from: unknown, to: unknown): number | null {
  return typeof from === 'number' && typeof to === 'number' && from !== to ? from - to : null;
}

const historyIdx = () => (window.history.state as { idx?: unknown } | null)?.idx;

/** The page being guarded: its path, its history entry, and whether it still
 *  holds edits the server lacks. */
interface Watch { path: string; idx: unknown; pending(): boolean; ask(): Promise<boolean> }
let watch: Watch | null = null;
/** Settles once the browser is back on the guarded page's entry. */
let undone: (() => void) | null = null;
let asking = false;
let passing = false;

/** The app's router has no blocker for Back and Forward, and it acts on a
 *  popstate in its own listener, synchronously. This one runs first because
 *  it is added before the router's (main.tsx imports this module for that):
 *  it undoes the move before the router hears of it, and makes it again on
 *  Leave. */
function onPop(e: PopStateEvent) {
  if (passing) { passing = false; return; }
  if (undone) { undone(); undone = null; e.stopImmediatePropagation(); return; }
  const w = watch;
  // a move within the page (only the query changes) is not leaving it
  if (!w || window.location.pathname === w.path || (!asking && !w.pending())) return;
  const back = stepsBack(w.idx, historyIdx());
  if (back === null) return;
  e.stopImmediatePropagation();
  const back$ = new Promise<void>((res) => { undone = res; });
  window.history.go(back);
  if (asking) return;
  asking = true;
  void Promise.all([w.ask(), back$]).then(([leave]) => {
    asking = false;
    if (!leave) return;
    passing = true;
    window.history.go(-back);
  });
}
if (typeof window !== 'undefined') window.addEventListener('popstate', onPop, true);

/**
 * While `pending()` holds, leaving this page for another one in the app asks
 * first (LEAVE_UNSAVED): the browser's Back and Forward, and the page's own
 * navigations, which go through the returned function.
 */
export function useLeaveGuard(pending: () => boolean): (go: () => void) => Promise<void> {
  const dialogs = useDialogs();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const location = useLocation();

  useEffect(() => {
    const mine: Watch = { path: window.location.pathname, idx: historyIdx(), pending: () => pendingRef.current(), ask: () => dialogs.confirm(LEAVE_UNSAVED) };
    watch = mine;
    return () => { if (watch === mine) watch = null; };
  }, [location, dialogs]);

  return useCallback(async (go: () => void) => {
    if (pendingRef.current() && !(await dialogs.confirm(LEAVE_UNSAVED))) return;
    go();
  }, [dialogs]);
}
