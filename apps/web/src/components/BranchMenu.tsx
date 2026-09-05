import { useEffect, useRef, useState } from 'react';
import { api, BranchInfo } from '../api';
import { useToast } from './Toast';

interface Props {
  projectId: string;
  current: string;
  onSwitch(name: string): void;
  onChanged(): void;
}

export default function BranchMenu({ projectId, current, onSwitch, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const load = () => api.branches(projectId).then(setBranches).catch(() => {});
  useEffect(() => { if (open) load(); }, [open, projectId]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await api.createBranch(projectId, n, current);
      setName('');
      setCreating(false);
      setOpen(false);
      onSwitch(n);
      onChanged();
      toast(`Created branch ${n}`, 'ok');
    } catch (err: any) {
      toast(`Could not create branch: ${err.message}`, 'error');
    }
  };

  const mergeIntoMain = async (from: string) => {
    try {
      const res = await api.merge(projectId, from, 'main');
      if (res.ok) {
        toast(`Merged ${from} into main`, 'ok');
        setOpen(false);
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
    let question = `Delete branch ${n}?`;
    try {
      const { count, newest } = await api.unmergedCommits(projectId, n);
      if (count > 0) {
        const newestPart = newest ? ` (newest: "${newest}")` : '';
        question = `Branch ${n} has ${count} checkpoint${count === 1 ? '' : 's'} that main does not have${newestPart}. Deleting the branch discards ${count === 1 ? 'it' : 'them'} for good. Delete anyway?`;
      }
    } catch { /* the plain question still stands */ }
    if (!window.confirm(question)) return;
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

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button className="branch-pill" onClick={() => setOpen(!open)} data-testid="branch-menu" title="Branches">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Zm0 2.122a3.25 3.25 0 1 0-1.5 0v5.256a3.25 3.25 0 1 0 1.5 0V9.5a2 2 0 0 1 2-2h3a3.5 3.5 0 0 0 3.5-3.5v-.372a3.25 3.25 0 1 0-1.5 0v.372a2 2 0 0 1-2 2h-3c-.729 0-1.412.195-2 .535ZM13.25 5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5Zm-8.5 7.75a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z"/></svg>
        {current}
      </button>
      {open && (
        <div className="menu" style={{ top: 32, left: 0 }} data-testid="branch-list">
          <div className="menu__label">Branches</div>
          {branches.map((b) => (
            <div key={b.name} style={{ display: 'flex', alignItems: 'center' }}>
              <button className="menu__item" style={{ flex: 1 }} onClick={() => { setOpen(false); onSwitch(b.name); }} data-testid={`branch-${b.name}`}>
                <span style={{ width: 14 }}>{b.name === current ? '✓' : ''}</span>
                {b.name}
              </button>
              {b.name !== 'main' && (
                <>
                  <button className="btn btn--ghost btn--small" title={`Merge ${b.name} into main`} onClick={() => mergeIntoMain(b.name)} data-testid={`merge-${b.name}`}>⤝ main</button>
                  <button className="btn btn--ghost btn--small" style={{ marginLeft: 6 }} title={`Delete ${b.name}`} onClick={() => remove(b.name)} data-testid={`delete-${b.name}`}>✕</button>
                </>
              )}
            </div>
          ))}
          <div className="menu__sep" />
          {creating ? (
            <input
              autoFocus
              className="input"
              style={{ width: '100%' }}
              placeholder="branch name"
              value={name}
              data-testid="new-branch-name"
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9._/-]/g, '-'))}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }}
            />
          ) : (
            <button className="menu__item" onClick={() => setCreating(true)} data-testid="new-branch">
              + New branch from {current}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
