import { useEffect, useRef, useState } from 'react';
import { api, BranchInfo, localUser } from '../api';
import { useToast } from './Toast';
import { useDialogs } from './Dialogs';
import Modal from './Modal';
import { useExitGhost } from '../exitGhost';
import { usePopover } from '../util/usePopover';
import { copySeen } from '../util/agentSeen';
import { askWaitingCommit } from '../util/waitingCommit';

export const BranchIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>
);

/** The project's own branches (a worktree each, on this server): list,
 *  create, merge into main, delete. `dialog` is the merge-conflict dialog,
 *  for the caller to render outside its menu. `manual`: the project commits
 *  by hand, so edits still waiting are committed under a message the person
 *  gives before a branch or a merge takes them along. */
export function useLocalBranches({ projectId, current, onSwitch, onChanged, close, manual = false }: {
  projectId: string;
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
  close(): void;
  manual?: boolean;
}) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  /** A merge into main that stopped on conflicts: the branch and the files. */
  const [conflict, setConflict] = useState<{ from: string; files: string[] } | null>(null);
  const [bringing, setBringing] = useState(false);
  const toast = useToast();
  const dialogs = useDialogs();

  const load = () => api.branches(projectId).then(setBranches).catch(() => {});

  /** The message for the edits waiting on `on`; undefined: none wait; null: cancelled. */
  const waiting = (on: string[], before: string, confirmLabel: string) =>
    (manual ? askWaitingCommit(dialogs, projectId, on, { before, confirmLabel }) : Promise.resolve(undefined));

  const create = async (n: string) => {
    const checkpoint = await waiting([current], 'branching', 'Commit and create branch');
    if (checkpoint === null) return false;
    try {
      await api.createBranch(projectId, n, current, checkpoint ? { message: checkpoint, author: localUser().name } : undefined);
      // Before the switch: the new branch's first open reads this mark.
      copySeen(projectId, current, n);
      close();
      onSwitch(n);
      onChanged();
      toast(`Created branch ${n}`, 'ok');
      return true;
    } catch (err: any) {
      toast(`Could not create branch: ${err.message}`, 'error');
      return false;
    }
  };

  const mergeIntoMain = async (from: string) => {
    // Main is everyone's branch, so the merge asks first and says what goes
    // in. It checkpoints the edits waiting on `from` before it merges, so
    // those count as something to merge.
    let count: number | null = null;
    let unsaved = false;
    try {
      const [u, waiting] = await Promise.all([
        api.unmergedCommits(projectId, from),
        api.changes(projectId, from).catch(() => ({ paths: [] as string[] })),
      ]);
      count = u.count;
      unsaved = waiting.paths.length > 0;
    } catch { /* the plain question still stands */ }
    if (count === 0 && !unsaved) {
      toast(`Nothing to merge: main already has everything on ${from}`, 'info');
      return;
    }
    let what = '';
    if (count) {
      const checkpoints = `${count} checkpoint${count === 1 ? '' : 's'} from ${from}`;
      what = unsaved ? `${checkpoints}, and its edits since the last one, go` : `${checkpoints} ${count === 1 ? 'goes' : 'go'}`;
    } else if (unsaved) {
      what = `The edits on ${from} since its last checkpoint go`;
    }
    const body = `${what ? `${what} into main. ` : ''}Everyone working on main sees them.`;
    if (!(await dialogs.confirm({ title: `Merge ${from} into main?`, body, confirmLabel: 'Merge into main' }))) return;
    const checkpoint = await waiting([from, 'main'], 'merging', 'Commit and merge');
    if (checkpoint === null) return;
    try {
      const res = await api.merge(projectId, from, 'main', localUser().name, checkpoint ? { checkpoint } : undefined);
      if (res.ok) {
        toast(`Merged ${from} into main`, 'ok');
        close();
        onSwitch('main');
        onChanged();
      } else if (res.conflicts?.length) {
        close();
        setConflict({ from, files: res.conflicts });
      } else {
        toast(res.message ? `Could not merge ${from} into main: ${res.message}` : `Could not merge ${from} into main`, 'error');
      }
    } catch (err: any) {
      toast(`Could not merge ${from} into main: ${err.message}`, 'error');
    }
  };

  /** Main's changes into the branch, both versions kept where they collide:
   *  the person settles them on the branch, then merges into main cleanly. */
  const bringMainIn = async () => {
    if (!conflict || bringing) return;
    const into = conflict.from;
    const checkpoint = await waiting(['main', into], 'bringing main in', 'Commit and bring main in');
    if (checkpoint === null) return;
    setBringing(true);
    try {
      const res = await api.merge(projectId, 'main', into, localUser().name, { keepConflicts: true, ...(checkpoint ? { checkpoint } : {}) });
      if (!res.ok) {
        toast(res.message ? `Could not bring main into ${into}: ${res.message}` : `Could not bring main into ${into}`, 'error');
        return;
      }
      setConflict(null);
      if (current !== into) onSwitch(into);
      onChanged();
      const marked = res.conflicts?.length ?? 0;
      toast(marked ? `Brought main into ${into}: ${marked === 1 ? '1 file holds' : `${marked} files hold`} both versions` : `Brought main into ${into}`, 'ok');
    } catch (err: any) {
      toast(`Could not bring main into ${into}: ${err.message}`, 'error');
    } finally {
      setBringing(false);
    }
  };

  const dialog = conflict && (
    <Modal onClose={() => setConflict(null)} label={`${conflict.from} and main changed the same lines`} width={480} testId="merge-conflict-dialog">
      <h2 style={{ marginBottom: 8 }}>{conflict.from} and main changed the same lines</h2>
      <p className="modal__sub">Nothing was merged. Both branches changed {conflict.files.length === 1 ? 'this file' : 'these files'}:</p>
      <ul className="conflict__list" data-testid="merge-conflict-files">{conflict.files.map((f) => <li key={f}>{f}</li>)}</ul>
      <p style={{ fontSize: 'var(--text-s)', color: 'var(--text-2)', lineHeight: 1.5 }}>
        Bring main into {conflict.from} to settle them there. Each of these files then holds both versions, between lines of
        {' '}<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code>. Keep the text you want, delete the rest
        and the marks, then merge {conflict.from} into main again.
      </p>
      <div className="modal__row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setConflict(null)} data-testid="merge-conflict-cancel">Cancel</button>
        <button className="btn btn--primary" onClick={() => void bringMainIn()} aria-disabled={bringing} data-testid="merge-conflict-bring-main">Bring main into {conflict.from}</button>
      </div>
    </Modal>
  );

  const remove = async (n: string) => {
    // Deleting is permanent (git branch -D, no reflog surfaced anywhere), so
    // the question names what goes with the branch.
    let body: string | undefined;
    try {
      const { count, newest } = await api.unmergedCommits(projectId, n);
      if (count > 0) {
        const newestPart = newest ? ` (newest: "${newest}")` : '';
        body = `It has ${count} checkpoint${count === 1 ? '' : 's'} that main does not have${newestPart}. Deleting the branch discards ${count === 1 ? 'it' : 'them'} for good.`;
      }
    } catch { /* the plain question still stands */ }
    if (!(await dialogs.confirm({ title: `Delete branch ${n}?`, body, confirmLabel: 'Delete branch', danger: true }))) return;
    try {
      await api.deleteBranch(projectId, n);
    } catch (err: any) {
      toast(`Could not delete branch: ${err.message}`, 'error');
      return;
    }
    if (current === n) onSwitch('main');
    load();
    onChanged();
  };

  return { branches, load, create, mergeIntoMain, remove, dialog };
}

export function LocalBranchRow({ name, current, onOpen, onMerge, onDelete, readOnly = false }: {
  name: string;
  current: boolean;
  onOpen(): void;
  onMerge(): void;
  onDelete(): void;
  /** A read-only showcase: its branches open, nothing merges or goes. */
  readOnly?: boolean;
}) {
  return (
    <div className="branch-menu__row">
      <button className="menu__item" onClick={onOpen} data-testid={`branch-${name}`}>
        <span className="branch-menu__check">{current ? '✓' : ''}</span>
        <span className="branch-menu__name">{name}</span>
      </button>
      {name !== 'main' && !readOnly && (
        <>
          <button className="btn btn--ghost btn--small" title={`Merge ${name} into main`} onClick={onMerge} data-testid={`merge-${name}`}>⤝ main</button>
          <button className="btn btn--ghost btn--small" title={`Delete ${name}`} onClick={onDelete} data-testid={`delete-${name}`}>✕</button>
        </>
      )}
    </div>
  );
}

/** "+ New branch from X", then a name field in its place. */
/** `blocked` is the sentence that says why this person cannot start one here. */
export function NewBranch({ from, onCreate, blocked }: { from: string; onCreate(name: string): Promise<boolean>; blocked?: string }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  /** Escape in the field: focus goes back to the button that replaces it, not to the page. */
  const cancelled = useRef(false);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    if (await onCreate(n)) { setName(''); setCreating(false); }
  };
  if (blocked) {
    return (
      <>
        <button className="menu__item" disabled aria-describedby="new-branch-blocked" data-testid="new-branch">
          <span className="branch-menu__check">+</span>New branch from {from}
        </button>
        <p className="branch-menu__note" id="new-branch-blocked" data-testid="new-branch-blocked">{blocked}</p>
      </>
    );
  }
  if (!creating) {
    return (
      <button className="menu__item" autoFocus={cancelled.current} onClick={() => setCreating(true)} data-testid="new-branch">
        <span className="branch-menu__check">+</span>New branch from {from}
      </button>
    );
  }
  return (
    <div className="branch-menu__new">
      <input
        autoFocus
        className="input"
        placeholder="branch name"
        value={name}
        data-testid="new-branch-name"
        onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9._/-]/g, '-'))}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setCreating(false); } }}
      />
      <button className="btn btn--small" onClick={submit} data-testid="new-branch-create">Create</button>
    </div>
  );
}

/** The branch pill of a project that lives only on this server. A linked
 *  project gets RemoteSync instead, which folds the git host in. */
export default function BranchMenu({ projectId, current, onSwitch, onChanged, onPublish, readOnly = false, manual = false }: {
  projectId: string;
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
  /** Set when this person may publish the project to a git host. */
  onPublish?: () => void;
  /** A read-only showcase: its branches can be opened, not created, merged or deleted. */
  readOnly?: boolean;
  /** The project commits by hand. */
  manual?: boolean;
}) {
  const pop = usePopover();
  const leave = useExitGhost();
  const local = useLocalBranches({ projectId, current, onSwitch, onChanged, close: pop.close, manual });
  useEffect(() => { if (pop.open) local.load(); }, [pop.open, projectId]);

  return (
    <div ref={pop.ref} className="branch">
      <button ref={pop.trigger} className="branch-pill" onClick={() => pop.setOpen(!pop.open)} data-testid="branch-menu" title="Branches" aria-expanded={pop.open}>
        <BranchIcon />
        <span className="branch-pill__name">{current}</span>
      </button>
      {pop.open && (
        <div ref={leave} className="menu branch-menu" data-testid="branch-list">
          <div className="menu__label">Branches</div>
          {local.branches.map((b) => (
            <LocalBranchRow
              key={b.name}
              name={b.name}
              current={b.name === current}
              onOpen={() => { pop.close(); onSwitch(b.name); }}
              onMerge={() => local.mergeIntoMain(b.name)}
              onDelete={() => local.remove(b.name)}
              readOnly={readOnly}
            />
          ))}
          {!readOnly && (
            <>
              <div className="menu__sep" />
              <NewBranch from={current} onCreate={local.create} />
            </>
          )}
          {onPublish && (
            <>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => { pop.close(); onPublish(); }} data-testid="remote-publish-open" title="Publish this project to a git host — backup + sync">
                <span className="branch-menu__check" />Publish to a git host…
              </button>
            </>
          )}
        </div>
      )}
      {local.dialog}
    </div>
  );
}
