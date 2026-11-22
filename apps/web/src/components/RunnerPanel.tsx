import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RunnerJob } from '../api';
import { safeStorage } from '../util/safeStorage';

/** The flag that shows this panel (the third switch of docs/RUNNER.md, D10). */
export const RUNNER_FLAG = 'aldine.experimental.runner';
const lastCommandKey = (projectId: string) => `aldine.runner.command.${projectId}`;
const POLL_MS = 1000;

/** Terminal escape sequences and direction controls never reach the screen:
 *  the log and the file names come from the job. */
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[\]P^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g, '').replace(/[‪-‮⁦-⁩‎‏؜]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Runs one command on a throwaway copy of the project and shows what came
 *  back. `onChanged`: files changed, as after an undo. */
export default function RunnerPanel({ projectId, branch, readOnly, onChanged }: { projectId: string; branch: string; readOnly: boolean; onChanged: () => void }) {
  const [command, setCommand] = useState(() => safeStorage.get(lastCommandKey(projectId)) ?? '');
  const [job, setJob] = useState<RunnerJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number | null>(null);
  const active = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [active]);

  const [reconnecting, setReconnecting] = useState(false);
  // A dropped connection or a restarting proxy is not the end of the run:
  // only an answer from the server about the run itself is.
  const poll = (id: string, misses = 0) => {
    timer.current = window.setTimeout(async () => {
      try {
        const { job: j } = await api.runnerJob(projectId, id);
        setReconnecting(false);
        setJob(j);
        if (j.status === 'queued' || j.status === 'running') poll(id);
        else if (j.result?.written.length) onChanged();
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        if ((status === 0 || status >= 500) && misses < 60) { setReconnecting(true); poll(id, misses + 1); return; }
        setReconnecting(false);
        setError((e as Error).message);
        setJob(null);
      }
    }, misses ? Math.min(POLL_MS * 2 ** misses, 5000) : POLL_MS);
  };

  const run = async () => {
    const c = command.trim();
    if (!c || active) return;
    setError(null);
    safeStorage.set(lastCommandKey(projectId), c);
    try {
      const { job: j } = await api.runnerRun(projectId, branch, c);
      setJob(j);
      setStarted(Date.now());
      poll(j.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const r = job?.result;
  return (
    <div className="runner" data-testid="runner-panel">
      <p className="runner__note">Experimental. Runs one command on a copy of this branch, without network access, and brings back the files it creates or changes.</p>
      <form className="runner__form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input
          className="input runner__command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="python analysis/plot.py"
          aria-label="Command to run"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={readOnly}
          data-testid="runner-command"
        />
        <button className="btn btn--small btn--primary" type="submit" disabled={readOnly || active || !command.trim()} data-testid="runner-run">
          {active ? 'Running…' : 'Run'}
        </button>
      </form>
      {readOnly && <p className="runner__note">You can view this project, not run commands in it.</p>}
      {error && <p className="runner__error" role="alert" data-testid="runner-error">{plain(error)}</p>}
      {job && (
        <div className="runner__result" role="status" aria-live="polite" data-testid="runner-status">
          {job.status === 'queued' && <p>Waiting for the runner{job.position ? ` (number ${job.position} in line)` : ''}…</p>}
          {job.status === 'running' && <p>Running for {seconds(now - (started ?? now))}…</p>}
          {reconnecting && <p className="runner__note" data-testid="runner-reconnecting">Lost the connection to the server; trying again…</p>}
          {job.status === 'failed' && <p className="runner__error" data-testid="runner-failed">The run failed: {plain(job.error ?? 'unknown error')}</p>}
          {r && (
            <>
              <p data-testid="runner-summary">
                {r.timedOut ? 'Stopped at the time limit' : r.exitCode === 0 ? 'Finished' : r.exitCode === null ? `Ended by ${r.signal ?? 'a signal'}` : `Exited with code ${r.exitCode}`}
                {' after '}{seconds(r.durationMs)}.{' '}
                {r.written.length ? `${r.written.length} file${r.written.length === 1 ? '' : 's'} updated.` : 'No files changed.'}
              </p>
              {r.written.length > 0 && (
                <ul className="runner__files" data-testid="runner-written">
                  {r.written.map((p) => <li key={p}>{plain(p)}</li>)}
                </ul>
              )}
              {r.deleted > 0 && <p className="runner__note">{r.deleted} file{r.deleted === 1 ? ' was' : 's were'} deleted in the run; deletions are not brought back.</p>}
              {r.skipped.length > 0 && (
                <details className="runner__skipped" data-testid="runner-skipped">
                  <summary>{r.skipped.length} file{r.skipped.length === 1 ? '' : 's'} not brought back</summary>
                  <ul>{r.skipped.map((s, i) => <li key={i}><code>{plain(s.path)}</code>: {plain(s.reason)}</li>)}</ul>
                </details>
              )}
              <pre className="runner__log" data-testid="runner-log">{plain(r.log) || '(no output)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
