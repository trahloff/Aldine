import { useCallback, useEffect, useRef, useState } from 'react';
import { api, CHANGE_REQUEST_OPEN, GIT_ACCESS_CODES, NO_CONNECTION, PULL_FIRST, RemoteLink, TOKEN_REJECTED } from '../api';
import { pushSummary, remoteDescriptor, sentence } from '../remotes';
import { useToast } from './Toast';
import { useDialogs } from './Dialogs';
import { useExitGhost } from '../exitGhost';
import { BranchIcon, LocalBranchRow, NewBranch, useLocalBranches } from './BranchMenu';
import { askWaitingCommit } from '../util/waitingCommit';
import { usePopover } from '../util/usePopover';
import { safeStorage } from '../util/safeStorage';
import RemoteAccess from './RemoteAccess';
import Modal from './Modal';

/** The branch pill of a project linked to a git host. The host's branches are
 *  the project's branches: local `main` tracks one of them, and push, pull
 *  and autopush act on `main` only, so they show only while main is open.
 *  Branches that exist only on this server are listed apart. Ahead/behind
 *  ride on the pill, with Pull or Push beside it only when commits wait.
 *  Switching the tracked branch, starting a host branch (which switches to
 *  it) and autopush are the owner's calls server-side. The provider comes from the link; the server never takes it
 *  from the request for these routes. */
// e2e shortens the interval through localStorage; nothing else sets it.
const REMOTE_POLL_MS = Number(safeStorage.get('aldine.remotePollMs')) || 90_000;

export default function RemoteSync({ projectId, link, autopush, isOwner, current, manual = false, reopenAccess = false, onSwitch, onChanged, onPulled, onAutopushChange, onOpenSettings, onReopened }: {
  projectId: string;
  link: RemoteLink;
  autopush: boolean;
  isOwner: boolean;
  /** The open branch of this project (local). */
  current: string;
  /** The project commits by hand ("Commit changes: When I commit"). */
  manual?: boolean;
  /** Open Git access once: a host connect started there came back. */
  reopenAccess?: boolean;
  onSwitch(name: string): void;
  onChanged(): void;
  onPulled(): void;
  onAutopushChange(v: boolean): void;
  onOpenSettings?(): void;
  onReopened?(): void;
}) {
  const p = link.provider;
  const d = remoteDescriptor(p);
  const [status, setStatus] = useState<{ ahead: number; behind: number } | null>(null);
  /** Why the last status check failed (token refusals aside): shown instead of "Checking…". */
  const [statusError, setStatusError] = useState<{ message: string; code?: string } | null>(null);
  const [autopushPaused, setAutopushPaused] = useState<{ since: string; message: string } | null>(null);
  const [busy, setBusy] = useState<'' | 'push' | 'pull' | 'reset' | 'branch'>('');
  const [showPush, setShowPush] = useState(false);
  /** What the push dialog sends: edits not yet committed (files) and commits the host lacks (null: unknown). */
  const [pushInfo, setPushInfo] = useState<{ pending: number; ahead: number | null }>({ pending: 1, ahead: null });
  const pushConfirm = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<{ files: string[]; keepAs: string | null } | null>(null);
  const [autopushBusy, setAutopushBusy] = useState(false);
  const [branchInfo, setBranchInfo] = useState<{ branches: string[]; current: string; default: string } | null>(null);
  const [crTitle, setCrTitle] = useState('');
  const [showCr, setShowCr] = useState(false);
  /** The host's words when it refused the token in use. Reconnect sits beside
   *  the pill until the token is changed in Git access: a status poll that
   *  works says nothing about the token on a host that lets anyone fetch. */
  const [rejected, setRejected] = useState<string | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  const pop = usePopover();
  const toast = useToast();
  const dialogs = useDialogs();
  const leave = useExitGhost();
  const local = useLocalBranches({ projectId, current, onSwitch, onChanged, close: pop.close, manual });

  const onMain = current === 'main';
  const tracked = branchInfo?.current ?? link.remoteBranch;
  const label = onMain ? tracked : current;
  const webUrl = /^https?:\/\//.test(link.cloneUrl) ? link.cloneUrl.replace(/\.git$/, '') : null;

  /** True when the failure was the host refusing the token: the pill then offers Reconnect. */
  const noteRejected = useCallback((err: any) => {
    if (err?.code !== TOKEN_REJECTED) return false;
    setRejected(err.message);
    return true;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const s = await api.projectRemoteStatus(projectId);
      setStatus({ ahead: s.ahead, behind: s.behind });
      setAutopushPaused(s.autopushPaused ?? null);
      setStatusError(null);
    } catch (err: any) {
      if (noteRejected(err)) return;
      setStatus(null);
      setStatusError({ message: err?.status ? err.message : `Could not check ${d.label}: this browser is offline.`, code: err?.code });
    }
  }, [projectId, noteRejected, d.label]);
  const loadBranches = useCallback(async () => {
    try { setBranchInfo(await api.remoteBranches(projectId)); } catch (err) { noteRejected(err); }
  }, [projectId, noteRejected]);
  /** A failed action: the toast says what happened and carries the next step
   *  when there is one (Reconnect, Pull, Git access, the open request); the
   *  pill then checks the host again, which has often moved on. */
  const failed = (err: any) => {
    const code = err?.code;
    const url = typeof err?.body?.url === 'string' && /^https?:\/\//.test(err.body.url) ? err.body.url as string : null;
    if (noteRejected(err)) toast(err.message, 'error', { label: 'Reconnect', testId: `${p}-reconnect-toast`, key: `${p}-rejected`, onClick: () => setShowAccess(true) });
    else if (code === PULL_FIRST) toast(err.message, 'error', { label: 'Pull', testId: `${p}-pull-first`, onClick: () => pullRef.current() });
    else if (code === NO_CONNECTION || GIT_ACCESS_CODES.includes(code)) toast(err.message, 'error', { label: 'Git access…', testId: `${p}-access-toast`, onClick: () => setShowAccess(true) });
    else if (code === CHANGE_REQUEST_OPEN && url) toast(err.message, 'info', { label: `Open #${err.body.number}`, testId: `${p}-open-existing`, onClick: () => window.open(url, '_blank', 'noopener') });
    else toast(err.message, 'error');
    void refresh();
  };
  useEffect(() => { refresh(); loadBranches(); }, [refresh, loadBranches]);
  useEffect(() => {
    if (!reopenAccess) return;
    setShowAccess(true);
    onReopened?.();
  }, [reopenAccess]);
  useEffect(() => { if (pop.open) { refresh(); loadBranches(); local.load(); } }, [pop.open]);

  // Co-authors push from elsewhere: look again while the tab is in view, and
  // the moment it comes back into view. The server fetches at most once per
  // 30 s per project, so every open editor polling costs one fetch.
  useEffect(() => {
    const tick = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(tick, REMOTE_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [refresh]);

  // What is waiting decides the dialog: with every edit already in a
  // checkpoint, a message would name nothing, so there is none.
  const openPush = async () => {
    pop.close();
    setMessage('Update from Aldine');
    setBusy('push');
    const [changes, s] = await Promise.all([
      api.changes(projectId, 'main').catch(() => null),
      api.projectRemoteStatus(projectId).catch(() => null),
    ]);
    if (s) setStatus({ ahead: s.ahead, behind: s.behind });
    setPushInfo({ pending: changes ? changes.paths.length : 1, ahead: s ? s.ahead : null });
    setBusy('');
    setShowPush(true);
  };
  const doPush = async (msg: string) => {
    setBusy('push'); setShowPush(false);
    try { await api.remotePush(projectId, msg); toast(`Pushed to ${d.label}`, 'ok'); await refresh(); }
    catch (err: any) { failed(err); }
    setBusy('');
  };
  const toggleAutopush = async () => {
    if (!isOwner || autopushBusy) return;
    setAutopushBusy(true);
    try {
      const r = await api.remoteAutopush(projectId, !autopush);
      toast(r.autopush ? `Autopush on: every autosave is pushed to ${d.label}` : 'Autopush off', 'ok');
      onAutopushChange(r.autopush);
    } catch (err: any) { toast(err.message, 'error'); }
    setAutopushBusy(false);
  };
  /** The message for the edits waiting on main, which every sync below commits first; null: cancelled. */
  const askWaiting = (before: string, confirmLabel: string) =>
    (manual ? askWaitingCommit(dialogs, projectId, ['main'], { before, confirmLabel }) : Promise.resolve(undefined));
  const pull = async () => {
    pop.close();
    const checkpoint = await askWaiting('pulling', 'Commit and pull');
    if (checkpoint === null) return;
    setBusy('pull');
    try {
      const r = await api.remotePull(projectId, checkpoint);
      if (r.conflict) setConflicts({ files: r.conflicts || [], keepAs: r.keepAs ?? null });
      else { toast(`Pulled from ${d.label}`, 'ok'); onPulled(); await refresh(); }
    } catch (err: any) { failed(err); }
    setBusy('');
  };
  // The server saves main as a branch only it has before main takes the
  // host's version, so the one way out keeps both.
  const keepBoth = async () => {
    setBusy('reset');
    try {
      const { kept } = await api.remoteResetToRemote(projectId);
      setConflicts(null);
      if (kept) toast(`Kept both: main has ${d.label}'s version, and everyone's changes not yet on ${d.label} are on ${kept}`, 'ok', { label: 'Open', testId: 'conflict-open-kept', onClick: () => onSwitch(kept) });
      else toast(`Took ${d.label}'s version`, 'ok');
      onPulled();
      local.load();
      await refresh();
    } catch (err: any) { failed(err); }
    setBusy('');
  };
  // A host branch is always opened through main, the branch that tracks it.
  // Switching repoints main for everyone, so it is asked first.
  const switchTo = async (branch: string) => {
    pop.close();
    if (branch === tracked) { if (!onMain) onSwitch('main'); return; }
    if (!(await dialogs.confirm({ title: `Switch the whole project to ${branch}?`, body: "Everyone's open files will change.", confirmLabel: 'Switch branch' }))) return;
    const checkpoint = await askWaiting('switching branch', 'Commit and switch');
    if (checkpoint === null) return;
    setBusy('branch');
    try {
      await api.remoteSwitchBranch(projectId, branch, checkpoint);
      toast(`Switched to ${branch}`, 'ok');
      if (!onMain) onSwitch('main');
      onPulled();
      await loadBranches();
      await refresh();
    } catch (err: any) { failed(err); }
    setBusy('');
  };
  const createOnHost = async (name: string) => {
    pop.close();
    const checkpoint = await askWaiting('starting the branch', 'Commit and create branch');
    if (checkpoint === null) return false;
    setBusy('branch');
    try {
      await api.remoteCreateBranch(projectId, name, checkpoint);
      toast(`Created branch ${name}`, 'ok');
      await loadBranches();
      await refresh();
      return true;
    } catch (err: any) { failed(err); return false; }
    finally { setBusy(''); }
  };
  const openChangeRequest = async () => {
    setShowCr(false);
    const checkpoint = await askWaiting(`opening the ${d.changeRequest}`, `Commit and open the ${d.changeRequest}`);
    if (checkpoint === null) return;
    try {
      const cr = await api.remoteChangeRequest(projectId, crTitle.trim() || undefined, checkpoint);
      toast(`Opened ${d.changeRequest} #${cr.number}`, 'ok');
      window.open(cr.url, '_blank', 'noopener');
    } catch (err: any) { failed(err); }
  };

  // Say so once when commits arrive during the session; what was waiting at
  // load time is already on the pill.
  const lastBehind = useRef<number | null>(null);
  const pullRef = useRef(pull);
  pullRef.current = pull;
  useEffect(() => {
    if (!status) return;
    const before = lastBehind.current;
    lastBehind.current = status.behind;
    if (before == null || status.behind <= before) return;
    const n = status.behind - before;
    toast(`${n} new ${n === 1 ? 'commit' : 'commits'} on ${d.label}`, 'info', { label: 'Pull', testId: `${p}-pull-toast`, key: `${p}-behind`, onClick: () => pullRef.current() });
  }, [status, d.label, p, toast]);

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const waiting = [
    ahead > 0 && `${ahead} ${ahead === 1 ? 'commit' : 'commits'} to push`,
    behind > 0 && `${behind} to pull`,
  ].filter(Boolean).join(' · ');
  const localOnly = local.branches.filter((b) => b.name !== 'main');
  const noConnection = statusError?.code === NO_CONNECTION;
  const nobody = `Nobody's ${d.label} account can sync this project`;
  const stateText = noConnection ? nobody : statusError ? statusError.message : status ? (waiting || 'No commits waiting') : `Checking ${d.label}…`;
  const openAccess = () => { pop.close(); setShowAccess(true); };
  // The host's own word for what autopush cannot do: nobody's account reaches it, or the push it last tried failed.
  const pausedBecause = !autopush ? null : noConnection ? `${nobody}, so nothing is pushed.` : autopushPaused?.message ?? null;

  return (
    <div ref={pop.ref} className="branch" data-testid={`${p}-sync`}>
      <button
        ref={pop.trigger}
        className="branch-pill"
        onClick={() => pop.setOpen(!pop.open)}
        disabled={busy === 'branch'}
        data-testid="branch-menu"
        title={`Branches · synced with ${link.fullName} on ${d.label}`}
        aria-expanded={pop.open}
      >
        <BranchIcon />
        <span className="branch-pill__name">{busy === 'branch' ? '…' : label}</span>
        {onMain && (ahead > 0 || behind > 0) && (
          <span className="branch-pill__counts" data-testid={`${p}-counts`}>
            {ahead > 0 && <span title={`${ahead} local commit(s) to push`}>↑{ahead}</span>}
            {behind > 0 && <span title={`${behind} remote commit(s) to pull`}>↓{behind}</span>}
          </span>
        )}
      </button>
      {rejected && (
        <button className="btn btn--small btn--danger" onClick={() => setShowAccess(true)} data-testid={`${p}-reconnect`} title={rejected}>
          Reconnect
        </button>
      )}
      {!rejected && noConnection && (
        <button className="btn btn--small" onClick={() => setShowAccess(true)} data-testid={`${p}-connect-pill`} title={`${nobody}. ${statusError?.message ?? ''}`.trim()}>
          Connect
        </button>
      )}
      {onMain && behind > 0 && (
        <button className="btn btn--small btn--primary" onClick={pull} disabled={!!busy} data-testid={`${p}-sync-action`} title={`Pull ${behind} new ${behind === 1 ? 'commit' : 'commits'} from ${d.label}`}>
          {busy === 'pull' ? '…' : 'Pull'}
        </button>
      )}
      {onMain && behind === 0 && ahead > 0 && (
        <button className="btn btn--small" onClick={openPush} disabled={!!busy} data-testid={`${p}-sync-action`} title={`Push ${ahead} ${ahead === 1 ? 'commit' : 'commits'} to ${d.label}`}>
          {busy === 'push' ? '…' : 'Push'}
        </button>
      )}

      {pop.open && (
        <div ref={leave} className="menu branch-menu" data-testid="branch-list">
          {webUrl
            ? <a className="branch-menu__repo" href={webUrl} target="_blank" rel="noopener noreferrer" data-testid={`${p}-repo-link`}>{d.icon}<span>{link.fullName}</span><span aria-hidden="true">↗</span></a>
            : <span className="branch-menu__repo">{d.icon}<span>{link.fullName}</span></span>}
          {rejected && <p className="branch-menu__note" style={{ color: 'var(--error)' }} data-testid={`${p}-token-rejected`}>{rejected}</p>}
          {onMain ? (
            <>
              <div className="branch-menu__sync">
                <span className="branch-menu__state" data-testid={`${p}-state`} style={statusError ? { color: 'var(--error)' } : undefined}>{stateText}</span>
                {noConnection ? (
                  <button className="btn btn--small btn--primary" onClick={openAccess} data-testid={`${p}-no-connection-access`} title={statusError?.message}>Git access…</button>
                ) : (
                  <>
                    <button className={`btn btn--small ${behind > 0 ? 'btn--primary' : ''}`} onClick={pull} disabled={!!busy} data-testid={`${p}-pull-btn`} title={`Pull from ${d.label}`}>Pull</button>
                    <button className="btn btn--small" onClick={openPush} disabled={!!busy} data-testid={`${p}-push-btn`} title={`Commit what is waiting and push to ${d.label}`}>Push…</button>
                  </>
                )}
              </div>
              <div className="branch-menu__setting">
                <span>Autopush</span>
                <button
                  className={`auto-toggle ${autopush ? 'auto-toggle--on' : ''}`}
                  onClick={toggleAutopush}
                  disabled={!isOwner || autopushBusy}
                  aria-pressed={autopush}
                  data-testid={`${p}-autopush`}
                  title={isOwner ? `Push every autosave to ${d.label} from the server` : 'Only the project owner can change autopush'}
                >
                  <span className="auto-toggle__knob" />
                  {autopush ? 'On' : 'Off'}
                </button>
              </div>
              {pausedBecause && (
                <p className="branch-menu__note" style={{ color: 'var(--warn-text)' }} data-testid={`${p}-autopush-paused`}
                  title={autopushPaused ? `Not pushed since ${new Date(autopushPaused.since).toLocaleString()}` : undefined}>
                  <strong>Autopush paused.</strong> {pausedBecause}
                </p>
              )}
            </>
          ) : (
            <p className="branch-menu__note" data-testid={`${p}-local-note`}>{current} exists only on this server. Push and pull work on main.</p>
          )}
          <div className="menu__sep" />
          <div className="menu__label">On {d.label}</div>
          {(branchInfo?.branches ?? [tracked]).map((b) => (
            <button
              key={b}
              className="menu__item"
              onClick={() => switchTo(b)}
              disabled={!isOwner && b !== tracked}
              title={!isOwner && b !== tracked ? 'Only the project owner can switch the tracked branch' : undefined}
              data-testid={`${p}-branch-${b}`}
            >
              <span className="branch-menu__check">{onMain && b === tracked ? '✓' : ''}</span>
              <span className="branch-menu__name">{b}</span>
              {b === branchInfo?.default && <span className="menu__hint">default</span>}
            </button>
          ))}
          {localOnly.length > 0 && (
            <>
              <div className="menu__label">Only on this server</div>
              {localOnly.map((b) => (
                <LocalBranchRow
                  key={b.name}
                  name={b.name}
                  current={b.name === current}
                  onOpen={() => { pop.close(); onSwitch(b.name); }}
                  onMerge={() => local.mergeIntoMain(b.name)}
                  onDelete={() => local.remove(b.name)}
                />
              ))}
            </>
          )}
          <div className="menu__sep" />
          <NewBranch
            from={label}
            onCreate={onMain ? createOnHost : local.create}
            blocked={onMain && !isOwner ? `Only the project owner can start a branch on ${d.label}, because it becomes the branch this project tracks for everyone.` : undefined}
          />
          {onMain && branchInfo && tracked !== branchInfo.default && (
            <button className="menu__item" onClick={() => { pop.close(); setCrTitle(`Update ${tracked}`); setShowCr(true); }} data-testid={`${p}-open-pr`}>
              <span className="branch-menu__check" />Open {d.changeRequest}…
            </button>
          )}
          <button className="menu__item" onClick={() => { pop.close(); setShowAccess(true); }} data-testid={`${p}-access`}>
            <span className="branch-menu__check" />Git access…
          </button>
        </div>
      )}

      {showPush && (
        <Modal onClose={() => setShowPush(false)} label={`Push to ${d.label}`} width={440} testId="push-dialog" initialFocus={pushInfo.pending > 0 ? 'first' : pushConfirm}>
          <h2 style={{ marginBottom: 8 }}>Push to {d.label}</h2>
          <p className="modal__sub" style={{ marginBottom: 10 }}>{link.fullName} · {tracked}</p>
          {pushInfo.pending > 0 && (
            <input className="input" style={{ width: '100%' }} value={message} data-testid="push-message"
              onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) doPush(message.trim() || 'Update from Aldine'); }} placeholder="Commit message" />
          )}
          <p className="push-dialog__note" data-testid="push-summary">{pushSummary(pushInfo, manual, d.label)}</p>
          {!manual && (
            <p className="push-dialog__note" data-testid="push-commit-mode">
              Every pause in typing is saved as a checkpoint, and each one reaches {d.label} as a commit of its own. For one commit per push, with your message, set Commit changes to “When I commit” in project settings.
              {onOpenSettings && <> <button className="btn btn--ghost btn--small push-dialog__link" onClick={() => { setShowPush(false); onOpenSettings(); }} data-testid="push-open-settings">Open project settings</button></>}
            </p>
          )}
          <div className="modal__row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setShowPush(false)}>Cancel</button>
            <button ref={pushConfirm} className="btn btn--primary" onClick={() => doPush(message.trim() || 'Update from Aldine')} data-testid="push-confirm">{pushInfo.pending > 0 ? 'Commit & push' : 'Push'}</button>
          </div>
        </Modal>
      )}

      {showCr && (
        <Modal onClose={() => setShowCr(false)} label={`Open ${d.changeRequest}`} testId="pr-dialog">
          <h2 style={{ marginBottom: 8 }}>Open {d.changeRequest}</h2>
          <p className="modal__sub" style={{ marginBottom: 10 }}>{tracked} → {branchInfo?.default}</p>
          <input className="input" style={{ width: '100%' }} value={crTitle} data-testid="pr-title" onChange={(e) => setCrTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) openChangeRequest(); }} placeholder={`${sentence(d.changeRequest)} title`} />
          <div className="modal__row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setShowCr(false)}>Cancel</button>
            <button className="btn btn--primary" onClick={openChangeRequest} data-testid="pr-confirm">Open on {d.label}</button>
          </div>
        </Modal>
      )}

      {showAccess && (
        <RemoteAccess
          projectId={projectId}
          provider={p}
          fullName={link.fullName}
          instance={link.baseUrl}
          isOwner={isOwner}
          rejected={rejected}
          onClose={() => setShowAccess(false)}
          onChanged={() => { setRejected(null); refresh(); loadBranches(); }}
        />
      )}

      {local.dialog}
      {conflicts && (
        <Modal onClose={() => setConflicts(null)} label="Merge conflict" width={480} testId="conflict-dialog">
          <h2 style={{ marginBottom: 8 }}>Merge conflict</h2>
          <p className="modal__sub">Everyone's changes not yet on {d.label} and {d.label}'s newer commits change the same lines{conflicts.files.length ? ' in:' : '.'}</p>
          {conflicts.files.length > 0 && <ul className="conflict__list">{conflicts.files.map((f) => <li key={f}>{f}</li>)}</ul>}
          <p className="conflict__note">Nothing has changed yet: main still has everyone's changes not yet on {d.label}.</p>
          {isOwner ? (
            <p className="conflict__note" data-testid="conflict-keep-note">
              Keep both saves them as the branch <strong>{conflicts.keepAs ?? 'my-version'}</strong>, which only this server has, and then main takes {d.label}'s version. Open that branch from the branch menu to copy what you need across.
            </p>
          ) : (
            <p className="conflict__note" data-testid="conflict-owner-note">
              Only the project owner can settle this, by keeping both versions. Until then your edits stay saved on this server, and Pull stops at this conflict again.
            </p>
          )}
          <div className="modal__row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setConflicts(null)}>{isOwner ? 'Cancel' : 'Close'}</button>
            {isOwner && (
              <>
                <button className="btn btn--primary" onClick={keepBoth} disabled={busy === 'reset'} data-testid="conflict-keep-both">Keep both</button>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

