import { useEffect, useRef, useState } from 'react';
import { api, GitlabNamespace } from '../api';
import { useToast } from './Toast';

const NAMESPACE_KEY = 'aldine.gitlab.namespace';

/** The group picked last time; the ZIP import sends it without a dialog.
 *  Undefined until the picker has been shown once, so an instance without
 *  provisioning never sends a namespace. */
export function rememberedNamespace(): string | undefined {
  try { return localStorage.getItem(NAMESPACE_KEY) || undefined; } catch { return undefined; }
}

function remember(ns: string) {
  try { localStorage.setItem(NAMESPACE_KEY, ns); } catch { /* private mode */ }
}

/** Which GitLab group a new project is provisioned into. Renders nothing
 *  until the server lists namespaces, and nothing at all when it cannot
 *  (404 = provisioning off, anything else = unreachable): creating a project
 *  never waits on GitLab. */
export default function NamespacePicker({ value, onChange }: { value: string | undefined; onChange(ns: string): void }) {
  const [list, setList] = useState<GitlabNamespace[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // The parent's callback identity may change per render; the initial pick
  // must fire once, after the first load only.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    api.gitlabNamespaces().then((r) => {
      if (cancelled) return;
      setList(r.namespaces);
      const remembered = rememberedNamespace();
      onChangeRef.current(remembered && r.namespaces.some((n) => n.fullPath === remembered) ? remembered : r.root);
    }).catch(() => { /* not configured or unreachable: stay hidden */ });
    return () => { cancelled = true; };
  }, []);

  if (!list) return null;

  const pick = (ns: string) => { remember(ns); onChange(ns); };

  const createSubgroup = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const g = await api.gitlabCreateSubgroup(value, name);
      const reloaded = await api.gitlabNamespaces().catch(() => null);
      setList(reloaded ? reloaded.namespaces : [...list, g]);
      pick(g.fullPath);
      setAdding(false);
      setNewName('');
      toast(`Created group ${g.fullPath}`, 'ok');
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };

  return (
    <div className="ns-picker" data-testid="namespace-picker">
      <label className="ns-picker__label" htmlFor="namespace-select">Create on GitLab in</label>
      <div className="ns-picker__row">
        <select
          id="namespace-select"
          className="input ns-picker__select"
          value={value ?? ''}
          data-testid="namespace-select"
          onChange={(e) => pick(e.target.value)}
        >
          {list.map((n) => <option key={n.fullPath} value={n.fullPath}>{n.fullPath}</option>)}
        </select>
        <button type="button" className="btn btn--small" onClick={() => setAdding((v) => !v)} data-testid="namespace-new" title={`Create a subgroup under ${value ?? 'the selected group'}`}>
          New subgroup…
        </button>
      </div>
      {adding && (
        <div className="ns-picker__row">
          <input
            className="input ns-picker__name"
            placeholder="Subgroup name"
            aria-label="Subgroup name"
            value={newName}
            data-testid="namespace-new-name"
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createSubgroup(); } }}
          />
          <button type="button" className="btn btn--small btn--primary" onClick={createSubgroup} disabled={busy || !newName.trim()} data-testid="namespace-new-create">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
      <p className="ns-picker__hint">The project is also created as a GitLab project in this group.</p>
    </div>
  );
}
