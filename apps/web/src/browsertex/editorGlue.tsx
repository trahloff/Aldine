import { useEffect, useState } from 'react';
import { engineStatus, onEngineStatus, typesetInfo, typesetsHere, warmEngine, type EngineStatus } from './host';

/**
 * What the Editor needs of typesetting in the browser, kept here so the
 * Editor's own changes stay a handful of conditions: whether this tab
 * typesets in this browser (and then always does, never adopting another
 * tab's PDF), the first download's progress, and claiming the runs an agent
 * or an API caller asks the branch for.
 */

/** Whether the server hands out TeX (`offered`) and this tab typesets with
 *  it (`here`); starts TeX loading when it does. */
export function useTypesetsHere(): { offered: boolean; here: boolean } {
  const [offered, setOffered] = useState(false);
  const [here, setHere] = useState(false);
  useEffect(() => {
    let live = true;
    void typesetInfo().then((info) => { if (live) setOffered(!!info); }, () => {});
    void typesetsHere().then((v) => {
      if (!live) return;
      setHere(v);
      if (v) void warmEngine();
    }, () => {});
    return () => { live = false; };
  }, []);
  return { offered, here };
}

function useEngineStatus(): EngineStatus {
  const [s, setS] = useState(engineStatus);
  useEffect(() => onEngineStatus(setS), []);
  return s;
}

const mb = (n: number) => Math.round(n / 1e6);

/** "Loading TeX… 40%" in the PDF pane's status while the first download runs. */
export function BrowserTexProgress() {
  const s = useEngineStatus();
  if (s.phase === 'loading') {
    const pct = s.total ? Math.min(99, Math.floor((100 * s.loaded) / s.total)) : null;
    return (
      <span data-testid="browser-tex-loading" title={s.total ? `Downloading TeX for this browser: ${mb(s.loaded)} of ${mb(s.total)} MB. Later visits load it from the browser's cache.` : 'Starting TeX in this browser'}>
        <span className="dot dot--busy" /> Loading TeX{pct !== null ? `… ${pct}%` : '…'}{' '}
      </span>
    );
  }
  if (s.phase === 'failed') {
    return <span data-testid="browser-tex-failed" title={s.error}><span className="dot dot--warn" /> TeX could not start in this browser{' '}</span>;
  }
  return null;
}

/** A tab on a server that hands out TeX, without TeX of its own: it shows
 *  the runs the tabs with TeX publish (they typeset every change) and asks
 *  for one only when its person presses Typeset. */
export async function followsPublished(): Promise<boolean> {
  return !!(await typesetInfo()) && !(await typesetsHere());
}

/** How long a tab that is not the branch's elected one leaves a waiting run
 *  to the elected tab before it tries to claim it itself. */
const FALLBACK_CLAIM_MS = 3000;

/** A run waits on the branch (the `bj` signal): claim and typeset it here. */
export function claimWaitingRun(projectId: string, branch: string, elected: boolean): void {
  setTimeout(() => {
    void import('./run').then((m) => m.claimBrowserJob(projectId, branch)).catch(() => { /* another tab's, or gone */ });
  }, elected ? 0 : FALLBACK_CLAIM_MS);
}

export { setPublisher } from './run';
export { typesetHerePreference, setTypesetHerePreference } from './host';
