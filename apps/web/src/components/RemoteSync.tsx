import { useCallback, useEffect, useRef, useState } from 'react';
import { api, RemoteLink } from '../api';
import { remoteDescriptor, sentence } from '../remotes';
import { useToast } from './Toast';
import { useExitGhost } from '../exitGhost';
import { BranchIcon, LocalBranchRow, NewBranch, useLocalBranches } from './BranchMenu';
import { usePopover } from '../util/usePopover';
import { safeStorage } from '../util/safeStorage';

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

export default function RemoteSync({ projectId, link, autopush, isOwner, current, onSwitch, onChanged, onPulled, onAutopushChange }: {
  projectId: string;
  link: RemoteLink;
  autopush: boolean;
  isOwner: boolean;
  /** The open branch of this project (local). */
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
  onPulled(): void;
  onAutopushChange(v: boolean): void;
}) {
  const p = link.provider;
  const d = remoteDescriptor(p);
  const [status, setStatus] = useState<{ ahead: number; behind: number } | null>(null);
  const [busy, setBusy] = useState<'' | 'push' | 'pull' | 'reset' | 'branch'>('');
  const [showPush, setShowPush] = useState(false);
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [autopushBusy, setAutopushBusy] = useState(false);
  const [branchInfo, setBranchInfo] = useState<{ branches: string[]; current: string; default: string } | null>(null);
  const [crTitle, setCrTitle] = useState('');
  const [showCr, setShowCr] = useState(false);
  const pop = usePopover();
  const toast = useToast();
  const leave = useExitGhost();
  const local = useLocalBranches({ projectId, current, onSwitch, onChanged, close: () => pop.setOpen(false) });

  const onMain = current === 'main';
  const tracked = branchInfo?.current ?? link.remoteBranch;
  const label = onMain ? tracked : current;
  const webUrl = /^https?:\/\//.test(link.cloneUrl) ? link.cloneUrl.replace(/\.git$/, '') : null;

  const refresh = useCallback(async () => {
    try { const s = await api.projectRemoteStatus(projectId); setStatus({ ahead: s.ahead, behind: s.behind }); }
    catch { /* offline / no token */ }
  }, [projectId]);
  const loadBranches = useCallback(async () => {
    try { setBranchInfo(await api.remoteBranches(projectId)); } catch { /* offline */ }
  }, [projectId]);
  useEffect(() => { refresh(); loadBranches(); }, [refresh, loadBranches]);
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

  const openPush = () => { pop.setOpen(false); setMessage('Update from Aldine'); setShowPush(true); };
  const doPush = async (msg: string) => {
    setBusy('push'); setShowPush(false);
    try { await api.remotePush(projectId, msg); toast(`Pushed to ${d.label}`, 'ok'); await refresh(); }
    catch (err: any) { toast(err.message, 'error'); }
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
  const pull = async () => {
    pop.setOpen(false);
    setBusy('pull');
    try {
      const r = await api.remotePull(projectId);
      if (r.conflict) setConflicts(r.conflicts || []);
      else { toast(`Pulled from ${d.label}`, 'ok'); onPulled(); await refresh(); }
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };
  const takeRemote = async () => {
    setBusy('reset');
    try { await api.remoteResetToRemote(projectId); toast(`Reset to the ${d.label} version`, 'ok'); setConflicts(null); onPulled(); await refresh(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };
  // A host branch is always opened through main, the branch that tracks it.
  const switchTo = async (branch: string) => {
    pop.setOpen(false);
    if (branch === tracked) { if (!onMain) onSwitch('main'); return; }
    setBusy('branch');
    try {
      await api.remoteSwitchBranch(projectId, branch);
      toast(`Switched to ${branch}`, 'ok');
      if (!onMain) onSwitch('main');
      onPulled();
      await loadBranches();
      await refresh();
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };
  const createOnHost = async (name: string) => {
    pop.setOpen(false);
    setBusy('branch');
    try {
      await api.remoteCreateBranch(projectId, name);
      toast(`Created branch ${name}`, 'ok');
      await loadBranches();
      await refresh();
      return true;
    } catch (err: any) { toast(err.message, 'error'); return false; }
    finally { setBusy(''); }
  };
  const openChangeRequest = async () => {
    setShowCr(false);
    try {
      const cr = await api.remoteChangeRequest(projectId, crTitle.trim() || undefined);
      toast(`Opened ${d.changeRequest} #${cr.number}`, 'ok');
      window.open(cr.url, '_blank', 'noopener');
    } catch (err: any) { toast(err.message, 'error'); }
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

  return (
    <div ref={pop.ref} className="branch" data-testid={`${p}-sync`}>
      <button
        className="branch-pill"
        onClick={() => pop.setOpen(!pop.open)}
        disabled={busy === 'branch'}
        data-testid="branch-menu"
        title={`Branches · synced with ${link.fullName} on ${d.label}`}
        aria-haspopup="menu"
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
          {onMain ? (
            <>
              <div className="branch-menu__sync">
                <span className="branch-menu__state" data-testid={`${p}-state`}>{status ? (waiting || 'No commits waiting') : `Checking ${d.label}…`}</span>
                <button className={`btn btn--small ${behind > 0 ? 'btn--primary' : ''}`} onClick={pull} disabled={!!busy} data-testid={`${p}-pull-btn`} title={`Pull from ${d.label}`}>Pull</button>
                <button className="btn btn--small" onClick={openPush} disabled={!!busy} data-testid={`${p}-push-btn`} title={`Commit what is waiting and push to ${d.label}`}>Push…</button>
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
                  onOpen={() => { pop.setOpen(false); onSwitch(b.name); }}
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
            <button className="menu__item" onClick={() => { pop.setOpen(false); setCrTitle(`Update ${tracked}`); setShowCr(true); }} data-testid={`${p}-open-pr`}>
              <span className="branch-menu__check" />Open {d.changeRequest}…
            </button>
          )}
        </div>
      )}

      {showPush && (
        <div className="modal-backdrop" onClick={() => setShowPush(false)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()} data-testid="push-dialog">
            <h2 style={{ marginBottom: 8 }}>Push to {d.label}</h2>
            <p className="modal__sub" style={{ marginBottom: 10 }}>{link.fullName} · {tracked}</p>
            <input className="input" style={{ width: '100%' }} value={message} data-testid="push-message" autoFocus
              onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doPush(message.trim() || 'Update from Aldine')} placeholder="Commit message" />
            <div className="modal__row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setShowPush(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={() => doPush(message.trim() || 'Update from Aldine')} data-testid="push-confirm">Commit &amp; push</button>
            </div>
          </div>
        </div>
      )}

      {showCr && (
        <div className="modal-backdrop" onClick={() => setShowCr(false)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()} data-testid="pr-dialog">
            <h2 style={{ marginBottom: 8 }}>Open {d.changeRequest}</h2>
            <p className="modal__sub" style={{ marginBottom: 10 }}>{tracked} → {branchInfo?.default}</p>
            <input className="input" style={{ width: '100%' }} value={crTitle} data-testid="pr-title" autoFocus onChange={(e) => setCrTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openChangeRequest()} placeholder={`${sentence(d.changeRequest)} title`} />
            <div className="modal__row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setShowCr(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={openChangeRequest} data-testid="pr-confirm">Open on {d.label}</button>
            </div>
          </div>
        </div>
      )}

      {conflicts && (
        <div className="modal-backdrop" onClick={() => setConflicts(null)}>
          <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()} data-testid="conflict-dialog">
            <h2 style={{ marginBottom: 8 }}>Merge conflict</h2>
            <p className="modal__sub">Your changes and {d.label}'s have diverged{conflicts.length ? ' in:' : '.'}</p>
            {conflicts.length > 0 && <ul className="conflict__list">{conflicts.map((f) => <li key={f}>{f}</li>)}</ul>}
            <p style={{ fontSize: 'var(--text-s)', color: 'var(--text-2)', lineHeight: 1.5 }}>
              Aldine kept your local version. You can discard your local changes and take {d.label}'s version, or cancel and reconcile manually.
            </p>
            <div className="modal__row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setConflicts(null)}>Cancel</button>
              <button className="btn btn--danger" onClick={takeRemote} disabled={busy === 'reset'} data-testid="conflict-take-remote">Discard local &amp; take {d.label}'s</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
