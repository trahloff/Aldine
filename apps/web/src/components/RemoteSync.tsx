import { useCallback, useEffect, useState } from 'react';
import { api, RemoteLink } from '../api';
import { remoteDescriptor, sentence } from '../remotes';
import { useToast } from './Toast';

/** Toolbar control for a project linked to a git host: branch switch/create
 *  + change request, ahead/behind, push (with a commit message), pull (with
 *  conflict handling), and the autopush toggle. Autopush is the server's
 *  job (it pushes after autosave commits on main) and the owner's setting:
 *  members see its state but cannot flip it. The provider comes from the
 *  link; the server never takes it from the request for these routes. */
export default function RemoteSync({ projectId, link, autopush, isOwner, onPulled, onAutopushChange }: {
  projectId: string;
  link: RemoteLink;
  autopush: boolean;
  isOwner: boolean;
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
  // branches
  const [branchInfo, setBranchInfo] = useState<{ branches: string[]; current: string; default: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [newName, setNewName] = useState('');
  const [crTitle, setCrTitle] = useState('');
  const [showCr, setShowCr] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try { const s = await api.projectRemoteStatus(projectId); setStatus({ ahead: s.ahead, behind: s.behind }); }
    catch { /* offline / no token */ }
  }, [projectId]);
  const loadBranches = useCallback(async () => {
    try { setBranchInfo(await api.remoteBranches(projectId)); } catch { /* offline */ }
  }, [projectId]);
  useEffect(() => { refresh(); loadBranches(); }, [refresh, loadBranches]);

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
  const switchTo = async (branch: string) => {
    setMenu(false);
    if (branch === branchInfo?.current) return;
    setBusy('branch');
    try { await api.remoteSwitchBranch(projectId, branch); toast(`Switched to ${branch}`, 'ok'); onPulled(); await loadBranches(); await refresh(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };
  const createBranch = async () => {
    const name = newName.trim(); if (!name) return;
    setBusy('branch'); setMenu(false); setNewName('');
    try { await api.remoteCreateBranch(projectId, name); toast(`Created branch ${name}`, 'ok'); await loadBranches(); await refresh(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };
  const openChangeRequest = async () => {
    setShowCr(false);
    try {
      const cr = await api.remoteChangeRequest(projectId, crTitle.trim() || undefined);
      toast(`Opened ${d.changeRequest} #${cr.number}`, 'ok');
      window.open(cr.url, '_blank', 'noopener');
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const onDefault = branchInfo && branchInfo.current === branchInfo.default;

  return (
    <div className="gh-sync" data-testid={`${p}-sync`} title={`Synced with ${link.fullName} on ${d.label}`}>
      {branchInfo && (
        <div className="gh-branch" onMouseLeave={() => setMenu(false)}>
          <button className="gh-branch__chip" onClick={() => setMenu((v) => !v)} disabled={busy === 'branch'} data-testid={`${p}-branch`} title={`Switch or create a ${d.label} branch`}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>
            {busy === 'branch' ? '…' : branchInfo.current}
          </button>
          {menu && (
            <div className="gh-branch__menu" data-testid={`${p}-branch-menu`}>
              <div className="gh-branch__label">Switch branch</div>
              {branchInfo.branches.map((b) => (
                <button key={b} className={`gh-branch__item ${b === branchInfo.current ? 'is-current' : ''}`} onClick={() => switchTo(b)} data-testid={`${p}-branch-${b}`}>
                  {b}{b === branchInfo.default && <span className="gh-branch__tag">default</span>}
                </button>
              ))}
              <div className="gh-branch__sep" />
              <div className="gh-branch__new">
                <input className="input" placeholder="new-branch-name" value={newName} data-testid={`${p}-new-branch`} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createBranch()} />
                <button className="btn btn--small" onClick={createBranch} data-testid={`${p}-create-branch`}>Create</button>
              </div>
              {!onDefault && <button className="gh-branch__item" onClick={() => { setMenu(false); setCrTitle(`Update ${branchInfo.current}`); setShowCr(true); }} data-testid={`${p}-open-pr`}>Open {d.changeRequest}…</button>}
            </div>
          )}
        </div>
      )}

      {status && (status.ahead > 0 || status.behind > 0) && (
        <span className="gh-sync__counts" data-testid={`${p}-counts`}>
          {status.ahead > 0 && <span title={`${status.ahead} local commit(s) to push`}>↑{status.ahead}</span>}
          {status.behind > 0 && <span title={`${status.behind} remote commit(s) to pull`}>↓{status.behind}</span>}
        </span>
      )}
      <button
        className={`gh-sync__autopush ${autopush ? 'gh-sync__autopush--on' : ''}`}
        onClick={toggleAutopush}
        disabled={!isOwner || autopushBusy}
        aria-pressed={autopush}
        data-testid={`${p}-autopush`}
        title={`Push every autosave to ${d.label} from the server`}
      >
        {autopush ? 'Autopush on' : 'Autopush off'}
      </button>
      <button className="btn btn--small" onClick={pull} disabled={!!busy} data-testid={`${p}-pull-btn`} title={`Pull from ${d.label}`}>{busy === 'pull' ? '…' : 'Pull'}</button>
      <button className="btn btn--small" onClick={() => { setMessage('Update from Aldine'); setShowPush(true); }} disabled={!!busy} data-testid={`${p}-push-btn`} title={`Push to ${d.label}`}>{busy === 'push' ? '…' : 'Push'}</button>

      {showPush && (
        <div className="modal-backdrop" onClick={() => setShowPush(false)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()} data-testid="push-dialog">
            <h2 style={{ marginBottom: 8 }}>Push to {d.label}</h2>
            <p className="modal__sub" style={{ marginBottom: 10 }}>{link.fullName} · {branchInfo?.current}</p>
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
            <p className="modal__sub" style={{ marginBottom: 10 }}>{branchInfo?.current} → {branchInfo?.default}</p>
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
            <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
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
