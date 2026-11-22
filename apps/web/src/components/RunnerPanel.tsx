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
const limit = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Result = NonNullable<RunnerJob['result']>;

/** How the command ended, in words; exit codes people meet are explained. */
function ending(r: Result, timeoutS: number): string {
  if (r.timedOut) return `Stopped at the time limit of ${limit(timeoutS)}`;
  if (r.exitCode === 0) return 'Finished';
  if (r.exitCode === 153 || r.signal === 'SIGXFSZ') return 'Stopped: a file reached the 32 MB size limit';
  if (r.exitCode === 137 || r.signal === 'SIGKILL') return 'Stopped by the system, most likely for using more than 1 GB of memory';
  if (r.exitCode === 127) return 'Exited with code 127: command not found';
  if (r.exitCode === null) return `Ended by ${r.signal ?? 'a signal'}`;
  return `Exited with code ${r.exitCode}`;
}

/** The last line that says what went wrong, for a failed run. */
function lastErrorLine(log: string): string | null {
  const lines = plain(log).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    if (/(error|exception|not found|no such|denied|traceback)/i.test(lines[i])) return lines[i];
  }
  return lines.length ? lines[lines.length - 1] : null;
}

/** Runs one command on a throwaway copy of the project and shows what came
 *  back. `onChanged`: files changed, as after an undo. */
export default function RunnerPanel({ projectId, branch, readOnly, onChanged, onOpenFile, scripts = [] }: {
  projectId: string;
  branch: string;
  readOnly: boolean;
  onChanged: () => void;
  onOpenFile?: (path: string) => void;
  /** The project's scripts, for a suggestion when nothing was run yet. */
  scripts?: string[];
}) {
  const [command, setCommand] = useState(() => safeStorage.get(lastCommandKey(projectId)) ?? '');
  const [job, setJob] = useState<RunnerJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [reconnecting, setReconnecting] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [stopping, setStopping] = useState(false);
  const timer = useRef<number | null>(null);
  const sending = useRef(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const active = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [active]);

  const settle = (j: RunnerJob) => {
    setStopping(false);
    if (j.stopped) { setAnnounce('Run stopped'); return; }
    if (j.status === 'failed') { setAnnounce('Run failed'); return; }
    const n = j.result?.written.length ?? 0;
    setAnnounce(`Run finished: ${n ? `${plural(n, 'file')} updated` : 'no files changed'}`);
    if (n) onChanged();
  };

  // A dropped connection or a restarting proxy is not the end of the run:
  // only an answer from the server about the run itself is.
  const poll = (id: string, misses = 0) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const { job: j } = await api.runnerJob(projectId, id);
        setReconnecting(false);
        setJob(j);
        if (j.status === 'queued' || j.status === 'running') poll(id);
        else settle(j);
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        if ((status === 0 || status >= 500) && misses < 60) { setReconnecting(true); poll(id, misses + 1); return; }
        setReconnecting(false);
        setError((e as Error).message);
        setJob(null);
      }
    }, misses ? Math.min(POLL_MS * 2 ** misses, 5000) : POLL_MS);
  };

  // The run outlives the panel: after a reload, in another tab or later, the
  // person's current or last run of this project is shown again.
  useEffect(() => {
    let gone = false;
    api.runnerLast(projectId).then(({ job: j }) => {
      if (gone || !j || j.branch !== branch) return;
      setJob(j);
      if (j.status === 'queued' || j.status === 'running') poll(j.id);
    }).catch(() => { /* the panel works without it */ });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, branch]);

  // A failed run's reason is at the end of its log.
  useEffect(() => {
    const r = job?.result;
    if (logRef.current && r && (r.exitCode !== 0 || r.timedOut)) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.result]);

  const run = async () => {
    const c = command.trim();
    if (!c || active || sending.current) return;
    sending.current = true;
    setError(null);
    safeStorage.set(lastCommandKey(projectId), c);
    try {
      const { job: j } = await api.runnerRun(projectId, branch, c);
      setJob(j);
      setAnnounce('Run started');
      poll(j.id);
    } catch (e) {
      // A run of this project is already on its way, perhaps from another tab: show that one.
      if (e instanceof ApiError && e.status === 409) {
        const { job: j } = await api.runnerLast(projectId).catch(() => ({ job: null }));
        if (j && (j.status === 'queued' || j.status === 'running')) { setJob(j); poll(j.id); return; }
      }
      setError((e as Error).message);
    } finally {
      sending.current = false;
    }
  };

  const stop = async () => {
    if (!job || !active) return;
    setStopping(true);
    try {
      const { job: j } = await api.runnerStop(projectId, job.id);
      setJob(j);
      if (j.status === 'queued' || j.status === 'running') poll(j.id); else settle(j);
    } catch (e) {
      setStopping(false);
      setError((e as Error).message);
    }
  };

  const r = job?.result;
  const failedRun = !!r && (r.timedOut || r.exitCode !== 0);
  const errorLine = failedRun && r ? lastErrorLine(r.log) : null;
  const suggestion = !command.trim() && scripts.length === 1 ? `python ${scripts[0]}` : null;
  const elapsed = job?.startedAt ? Math.max(0, now - job.startedAt) : 0;

  return (
    <div className="runner" data-testid="runner-panel">
      <div className="runner__head">
        <h3 className="runner__title">Runner <span className="runner__badge">experimental</span></h3>
        <p className="runner__note">
          Runs one command on a copy of this branch and brings back the files it creates or changes. Python 3.13 with NumPy and Matplotlib, and LaTeX for PGF figures. No network, so packages cannot be installed.
        </p>
      </div>
      <form className="runner__form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input
          className="input runner__command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={suggestion ?? 'python plot.py'}
          aria-label="Command to run"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={readOnly}
          data-testid="runner-command"
        />
        {active ? (
          <button className="btn btn--small" type="button" onClick={() => void stop()} disabled={stopping} data-testid="runner-stop">
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button className="btn btn--small btn--primary" type="submit" disabled={readOnly || !command.trim()} data-testid="runner-run">Run</button>
        )}
      </form>
      {suggestion && (
        <p className="runner__note">
          Try <button type="button" className="search__link runner__suggest" onClick={() => setCommand(suggestion)} data-testid="runner-suggest"><code>{suggestion}</code></button>
        </p>
      )}
      {readOnly && <p className="runner__note">You can view this project, not run commands in it.</p>}
      {error && <p className="runner__error" role="alert" data-testid="runner-error">{plain(error)}</p>}
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="runner-announce">{announce}</p>
      {job && (
        <div className="runner__result" data-testid="runner-status">
          {job.status === 'queued' && <p>Waiting for the runner{job.position ? ` (number ${job.position} in line)` : ''}…</p>}
          {job.status === 'running' && <p>{stopping ? 'Stopping' : 'Running'} for {seconds(elapsed)} of at most {limit(job.timeoutS)}…</p>}
          {reconnecting && <p className="runner__note" data-testid="runner-reconnecting">Lost the connection to the server; trying again…</p>}
          {job.status === 'failed' && (job.stopped
            ? <p data-testid="runner-stopped">Stopped. No files were brought back.</p>
            : <p className="runner__error" data-testid="runner-failed">The run failed: {plain(job.error ?? 'unknown error')}</p>)}
          {r && (
            <>
              <p data-testid="runner-summary" className={failedRun ? 'runner__summary runner__summary--failed' : 'runner__summary'}>
                {ending(r, job.timeoutS)}{' after '}{seconds(r.durationMs)}.{' '}
                {r.written.length
                  ? `${plural(r.written.length, 'file')} updated${failedRun ? ' anyway' : ''}.`
                  : r.skipped.length ? `No files changed; ${plural(r.skipped.length, 'file')} not brought back.` : 'No files changed.'}
              </p>
              {errorLine && <p className="runner__errline" data-testid="runner-errline"><code>{errorLine}</code></p>}
              {r.written.length > 0 && (
                <ul className="runner__files" data-testid="runner-written">
                  {r.written.map((p) => (
                    <li key={p}>
                      {onOpenFile
                        ? <button type="button" className="search__link" onClick={() => onOpenFile(p)} title="Open this file">{plain(p)}</button>
                        : plain(p)}
                    </li>
                  ))}
                </ul>
              )}
              {r.deleted > 0 && <p className="runner__note">{r.deleted} file{r.deleted === 1 ? ' was' : 's were'} deleted in the run; deletions are not brought back.</p>}
              {r.skipped.length > 0 && (
                <details className={r.written.length ? 'runner__skipped' : 'runner__skipped runner__skipped--alone'} open={!r.written.length} data-testid="runner-skipped">
                  <summary>{plural(r.skipped.length, 'file')} not brought back</summary>
                  <ul>{r.skipped.map((s, i) => <li key={i}><code>{plain(s.path)}</code>: {plain(s.reason)}</li>)}</ul>
                </details>
              )}
              <h4 className="runner__loghead">Output</h4>
              <pre ref={logRef} className="runner__log" data-testid="runner-log" tabIndex={0} aria-label="Output of the run">{plain(r.log) || '(no output)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
