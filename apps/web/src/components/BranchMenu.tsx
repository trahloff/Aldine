import { useEffect, useState } from 'react';
import { api, BranchInfo } from '../api';
import { useToast } from './Toast';
import { useDialogs } from './Dialogs';
import { useExitGhost } from '../exitGhost';
import { usePopover } from '../util/usePopover';

export const BranchIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.25a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Zm0 2.122a3.25 3.25 0 1 0-1.5 0v5.256a3.25 3.25 0 1 0 1.5 0V9.5a2 2 0 0 1 2-2h3a3.5 3.5 0 0 0 3.5-3.5v-.372a3.25 3.25 0 1 0-1.5 0v.372a2 2 0 0 1-2 2h-3c-.729 0-1.412.195-2 .535ZM13.25 5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5Zm-8.5 7.75a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z"/></svg>
);

/** The project's own branches (a worktree each, on this server): list,
 *  create, merge into main, delete. */
export function useLocalBranches({ projectId, current, onSwitch, onChanged, close }: {
  projectId: string;
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
  close(): void;
}) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const toast = useToast();
  const dialogs = useDialogs();

  const load = () => api.branches(projectId).then(setBranches).catch(() => {});

  const create = async (n: string) => {
    try {
      await api.createBranch(projectId, n, current);
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
    try {
      const res = await api.merge(projectId, from, 'main');
      if (res.ok) {
        toast(`Merged ${from} into main`, 'ok');
        close();
        onSwitch('main');
        onChanged();
      } else {
        toast(res.conflicts?.length ? `Merge conflicts in: ${res.conflicts.join(', ')}` : 'Merge failed', 'error');
      }
    } catch (err: any) {
      toast(`Merge failed: ${err.message}`, 'error');
    }
  };

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

  return { branches, load, create, mergeIntoMain, remove };
}

export function LocalBranchRow({ name, current, onOpen, onMerge, onDelete }: {
  name: string;
  current: boolean;
  onOpen(): void;
  onMerge(): void;
  onDelete(): void;
}) {
  return (
    <div className="branch-menu__row">
      <button className="menu__item" onClick={onOpen} data-testid={`branch-${name}`}>
        <span className="branch-menu__check">{current ? '✓' : ''}</span>
        <span className="branch-menu__name">{name}</span>
      </button>
      {name !== 'main' && (
        <>
          <button className="btn btn--ghost btn--small" title={`Merge ${name} into main`} onClick={onMerge} data-testid={`merge-${name}`}>⤝ main</button>
          <button className="btn btn--ghost btn--small" title={`Delete ${name}`} onClick={onDelete} data-testid={`delete-${name}`}>✕</button>
        </>
      )}
    </div>
  );
}

/** "+ New branch from X", then a name field in its place. */
export function NewBranch({ from, onCreate }: { from: string; onCreate(name: string): Promise<boolean> }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    if (await onCreate(n)) { setName(''); setCreating(false); }
  };
  if (!creating) {
    return (
      <button className="menu__item" onClick={() => setCreating(true)} data-testid="new-branch">
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
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); setCreating(false); } }}
      />
      <button className="btn btn--small" onClick={submit} data-testid="new-branch-create">Create</button>
    </div>
  );
}

/** The branch pill of a project that lives only on this server. A linked
 *  project gets RemoteSync instead, which folds the git host in. */
export default function BranchMenu({ projectId, current, onSwitch, onChanged, onPublish }: {
  projectId: string;
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
  /** Set when this person may publish the project to a git host. */
  onPublish?: () => void;
}) {
  const pop = usePopover();
  const leave = useExitGhost();
  const local = useLocalBranches({ projectId, current, onSwitch, onChanged, close: () => pop.setOpen(false) });
  useEffect(() => { if (pop.open) local.load(); }, [pop.open, projectId]);

  return (
    <div ref={pop.ref} className="branch">
      <button className="branch-pill" onClick={() => pop.setOpen(!pop.open)} data-testid="branch-menu" title="Branches" aria-haspopup="menu" aria-expanded={pop.open}>
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
              onOpen={() => { pop.setOpen(false); onSwitch(b.name); }}
              onMerge={() => local.mergeIntoMain(b.name)}
              onDelete={() => local.remove(b.name)}
            />
          ))}
          <div className="menu__sep" />
          <NewBranch from={current} onCreate={local.create} />
          {onPublish && (
            <>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => { pop.setOpen(false); onPublish(); }} data-testid="remote-publish-open" title="Publish this project to a git host — backup + sync">
                <span className="branch-menu__check" />Publish to a git host…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
