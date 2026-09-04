import { useEffect, useState } from 'react';
import { api, GitlabNamespace } from '../api';
import { useToast } from './Toast';

const LAST_USED = 'aldine.gitlab.namespace';

/**
 * Where in the GitLab group tree a new project should live. Renders nothing when
 * the deployment has no default group configured — the New project modal must
 * look exactly as it did before auto-provisioning existed.
 */
export default function NamespacePicker({ value, onChange }: {
  value: string;
  onChange(path: string): void;
}) {
  const [namespaces, setNamespaces] = useState<GitlabNamespace[] | null>(null);
  const [root, setRoot] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = () => api.gitlabNamespaces()
    .then((r) => {
      setRoot(r.root);
      setNamespaces(r.namespaces);
      if (!value) {
        const last = localStorage.getItem(LAST_USED);
        onChange(last && r.namespaces.some((n) => n.fullPath === last) ? last : r.root);
      }
      return r;
    })
    // A 404 means no default group is configured, which is the signal to hide.
    .catch(() => setNamespaces([]));

  useEffect(() => { load(); }, []);

  const select = (path: string) => {
    onChange(path);
    try { localStorage.setItem(LAST_USED, path); } catch { /* private mode */ }
  };

  const createSubgroup = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const g = await api.gitlabCreateSubgroup(value || root, name);
      const r = await load();
      // Select the new subgroup even if the refresh raced, so the choice sticks.
      select(g.fullPath);
      if (r && !r.namespaces.some((n) => n.fullPath === g.fullPath)) setNamespaces([...r.namespaces, { id: g.id, fullPath: g.fullPath, name }]);
      setCreating(false);
      setNewName('');
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };

  if (!namespaces || namespaces.length === 0) return null;

  const depth = (p: string) => (p === root ? 0 : p.slice(root.length + 1).split('/').length);

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ display: 'block', marginBottom: 4, color: 'var(--text-2)', fontSize: 12.5 }}>Save in</label>
      <select
        className="input"
        style={{ width: '100%' }}
        value={value || root}
        data-testid="namespace-select"
        onChange={(e) => select(e.target.value)}
      >
        {namespaces.map((n) => (
          <option key={n.fullPath} value={n.fullPath}>
            {' '.repeat(depth(n.fullPath) * 3)}{n.fullPath}
          </option>
        ))}
      </select>

      {creating ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input
            className="input" style={{ flex: 1 }} placeholder="Subgroup name" value={newName} autoFocus
            data-testid="namespace-new-name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createSubgroup()}
          />
          <button className="btn btn--small" onClick={createSubgroup} disabled={busy} data-testid="namespace-new-create">
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn--ghost btn--small" style={{ marginTop: 6 }} onClick={() => setCreating(true)} data-testid="namespace-new">
          New subgroup…
        </button>
      )}
    </div>
  );
}
