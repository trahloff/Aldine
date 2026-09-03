import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, ProjectSummary, TemplateInfo } from '../api';
import { useToast } from '../components/Toast';
import { useAuth } from '../components/Auth';
import Modal from '../components/Modal';
import ShareModal from '../components/ShareModal';
import { IconDoc, IconLink, IconX } from '../components/Icons';
import AccountSettings from '../components/AccountSettings';
import { getTheme, toggleTheme } from '../theme';
import GithubImport from '../components/GithubImport';
import Onboarding from '../components/Onboarding';
import About from '../components/About';
import { friendlyDate } from '../util/dates';
import { OAUTH_RESUME_KEY } from '../util/oauthParams';
import { pickTemplate, templateToPost } from '../util/templates';
import { importSummary } from '../util/engines';

/** Mirrors IMPORT_MAX_ZIP_BYTES in apps/server/src/routes.ts — the server
 *  enforces it; this pre-flight only spares the upload. */
const IMPORT_MAX_ZIP_MB = 60;
const IMPORT_MAX_ZIP_BYTES = IMPORT_MAX_ZIP_MB * 1024 * 1024;

export default function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [themeChoice, setThemeChoice] = useState(getTheme());
  const [newName, setNewName] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [template, setTemplate] = useState('article');
  const [sharing, setSharing] = useState<ProjectSummary | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [trash, setTrash] = useState<{ id: string; name: string; deletedAt: string }[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => localStorage.getItem('aldine.onboarded') !== '1');
  const dismissOnboarding = () => { localStorage.setItem('aldine.onboarded', '1'); setShowOnboarding(false); };
  const navigate = useNavigate();
  const toast = useToast();
  const { authEnabled, user, setUser } = useAuth();

  const load = () => {
    api.listTrash().then(setTrash).catch(() => setTrash([]));
    return api.listProjects()
      .then((p) => { setProjects(p); setLoadFailed(false); })
      .catch(() => { setLoadFailed(true); setProjects((cur) => cur ?? []); });
  };
  useEffect(() => { load(); }, []);
  // Signed in through an SSO provider while an app was waiting on
  // /oauth/authorize: the provider callback lands here, so resume the consent.
  useEffect(() => {
    if (!authEnabled || !user) return;
    let resume: string | null = null;
    try { resume = sessionStorage.getItem(OAUTH_RESUME_KEY); sessionStorage.removeItem(OAUTH_RESUME_KEY); } catch { /* private mode */ }
    if (resume) navigate(`/oauth/authorize${resume}`, { replace: true });
  }, []);
  // returning from GitHub OAuth connect → reopen the import flow (now connected)
  useEffect(() => {
    if (new URLSearchParams(location.search).get('github') === 'connected') {
      setShowGithub(true);
      window.history.replaceState({}, '', location.pathname);
    }
  }, []);
  useEffect(() => {
    api.templates().then((list) => {
      setTemplates(list);
      setTemplate((cur) => pickTemplate(list, cur));
    }).catch(() => setTemplates([]));
  }, []);

  const create = async () => {
    const name = newName.trim() || 'Untitled Project';
    try {
      const p = await api.createProject(name, undefined, templateToPost(templates, template));
      navigate(`/p/${p.id}`);
    } catch (err: any) {
      toast(`Could not create project: ${err.message}`, 'error');
    }
  };

  const importZip = async (file: File) => {
    if (!/\.zip$/i.test(file.name)) { toast('Please drop a .zip file', 'error'); return; }
    const sizeMb = Number((file.size / (1024 * 1024)).toFixed(1));
    if (file.size > IMPORT_MAX_ZIP_BYTES) { toast(`ZIP is ${sizeMb} MB; the limit is ${IMPORT_MAX_ZIP_MB} MB`, 'error'); return; }
    toast('Importing…');
    try {
      const p = await api.importZip(file.name.replace(/\.zip$/i, ''), file);
      toast(importSummary(p), 'ok');
      navigate(`/p/${p.id}`, { state: { import: p.import } });
    } catch (err: any) {
      // A 413 without the route's own text comes from a proxy or body limit
      // below what the app allows — the size is the only number worth stating.
      if (err instanceof ApiError && err.status === 413 && !/limit is/.test(err.message)) {
        toast(`ZIP too large for this server: ${sizeMb} MB was refused before it reached the app, which allows ${IMPORT_MAX_ZIP_MB} MB`, 'error');
        return;
      }
      toast(`Import failed: ${err.message}`, 'error');
    }
  };

  const remove = async (e: React.MouseEvent, p: ProjectSummary) => {
    e.stopPropagation();
    if (!window.confirm(`Move “${p.name}” to the trash? You can restore it for 30 days.`)) return;
    try {
      await api.deleteProject(p.id);
      toast(`Moved ${p.name} to the trash`, 'ok');
      load();
    } catch (err: any) {
      toast(`Could not delete ${p.name}: ${err.message}`, 'error');
    }
  };

  const claim = async (e: React.MouseEvent, p: ProjectSummary) => {
    e.stopPropagation();
    if (!window.confirm(`Claim “${p.name}”? You become its owner and other users lose access.`)) return;
    try { await api.claimProject(p.id); toast(`You now own ${p.name}`, 'ok'); }
    catch (err: any) { toast(err.message, 'error'); } // e.g. someone claimed it first
    load(); // winner sees owner controls; a loser sees the project disappear
  };

  const restore = async (id: string, name: string) => {
    try { await api.restoreProject(id); toast(`Restored ${name}`, 'ok'); load(); }
    catch (err: any) { toast(err.message, 'error'); }
  };

  const purge = async (id: string, name: string) => {
    if (!window.confirm(`Permanently delete “${name}”? This cannot be undone.`)) return;
    try { await api.deleteProject(id, true); toast(`Deleted ${name} forever`, 'ok'); load(); }
    catch (err: any) { toast(err.message, 'error'); }
  };

  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`home ${dragOver ? 'home--drag' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) await importZip(f);
      }}
    >
      <div className="home__inner">
        <div className="home__bar">
          <div>
            <h1 className="home__brand">aldine<em>.</em></h1>
            <p className="home__tag">Write LaTeX together. Fast, versioned, yours.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn"
              data-testid="theme-toggle"
              title="Switch light/dark theme"
              aria-label="Switch light/dark theme"
              onClick={() => setThemeChoice(toggleTheme())}
            >
              {themeChoice === 'dark' ? '☀︎' : '☾'}
            </button>
            {authEnabled && user && (
              <span className="user-chip">
                <button className="user-chip__name" data-testid="user-name" onClick={() => setShowAccount(true)} title="Account settings">{user.name}</button>
                <button className="btn btn--small" data-testid="logout" onClick={async () => { await api.logout(); setUser(null); }}>Sign out</button>
              </span>
            )}
            <label className="btn" data-testid="import-zip">
              Import ZIP
              <input type="file" accept=".zip" hidden data-testid="import-input" aria-label="Import a project from a ZIP file"
                onChange={async (e) => { if (e.target.files?.[0]) await importZip(e.target.files[0]); e.target.value = ''; }} />
            </label>
            <button className="btn" onClick={() => setShowGithub(true)} data-testid="new-from-github">
              From GitHub
            </button>
            <button className="btn btn--primary" onClick={() => setCreating(true)} data-testid="new-project">
              New project
            </button>
          </div>
        </div>

        {projects === null ? (
          <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>
        ) : loadFailed ? (
          <div className="empty">
            <p style={{ margin: '0 0 16px' }}>Couldn’t reach the server to load your projects.</p>
            <button className="btn btn--primary" onClick={load}>Try again</button>
          </div>
        ) : projects.length === 0 ? (
          <div className="empty">
            <p style={{ margin: '0 0 16px' }}>No projects yet — start a paper however you like.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn--primary" onClick={() => setCreating(true)}>New project</button>
              <button className="btn" onClick={() => setShowGithub(true)}>Import from GitHub</button>
              <label className="btn">Import a ZIP
                <input type="file" accept=".zip" hidden onChange={async (e) => { if (e.target.files?.[0]) await importZip(e.target.files[0]); e.target.value = ''; }} />
              </label>
            </div>
          </div>
        ) : (
          <div className="projects" data-testid="project-grid">
            {projects.map((p) => {
              // Deleting is owner-only server-side; without auth everyone owns
              // everything. Don't offer what the server will refuse.
              const canManage = !authEnabled || !!p.isOwner;
              return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className="project-card"
                data-testid={`project-card-${p.id}`}
                onClick={() => navigate(`/p/${p.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/p/${p.id}`)}
              >
                <span className="project-card__icon"><IconDoc width={20} height={20} /></span>
                <span className="project-card__name">{p.name}</span>
                <span className="project-card__meta">
                  <span>{friendlyDate(p.createdAt)}</span>
                  {authEnabled && p.ownerId && !p.isOwner && <span title={`Shared by ${p.ownerName || 'someone'}`}>· shared</span>}
                  {authEnabled && !p.ownerId && (
                    <button className="btn btn--small" style={{ marginLeft: 'auto' }} data-testid={`claim-${p.id}`}
                      title="This project predates accounts on this server and has no owner yet"
                      onClick={(e) => claim(e, p)}>Claim</button>
                  )}
                  {p.zotero && <span title="Zotero linked" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><IconLink /> Zotero</span>}
                  {authEnabled && p.isOwner && (
                    <button className="project-card__del" title={p.share?.mode === 'link' ? 'Shared by link — anyone signed in with the link can edit' : 'Share project'} style={{ marginLeft: 'auto' }} data-testid={`share-${p.id}`}
                      onClick={(e) => { e.stopPropagation(); setSharing(p); }}><IconLink /></button>
                  )}
                  {canManage && (
                    <button className="project-card__del" title="Delete project" aria-label={`Delete ${p.name}`} style={authEnabled && p.isOwner ? undefined : { marginLeft: 'auto' }} onClick={(e) => remove(e, p)}><IconX /></button>
                  )}
                </span>
              </div>
              );
            })}
          </div>
        )}

        {trash.length > 0 && (
          <p style={{ textAlign: 'center', marginTop: 26 }}>
            <button className="btn btn--ghost btn--small" onClick={() => setShowTrash(true)} data-testid="open-trash">
              Trash ({trash.length})
            </button>
          </p>
        )}

        {/* AGPL section 13: a network instance must offer its users the source. */}
        <p className="home__legal">
          <button className="btn btn--ghost btn--small" onClick={() => setAboutOpen(true)} data-testid="open-about">
            About &amp; source
          </button>
        </p>
      </div>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}

      {showTrash && (
        <Modal onClose={() => setShowTrash(false)} label="Trash" testId="trash-modal">
          <div>
            <h2 style={{ marginBottom: 2 }}>Trash</h2>
            <p className="modal__sub">Deleted projects are kept for 30 days, then removed permanently.</p>
            {trash.length === 0 && <p style={{ color: 'var(--text-2)' }}>The trash is empty.</p>}
            {trash.map((t) => (
              <div key={t.id} className="settings__row" style={{ alignItems: 'center', gap: 10 }} data-testid={`trash-${t.id}`}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}>{friendlyDate(t.deletedAt)}</span>
                  <button className="btn btn--small" onClick={() => restore(t.id, t.name)} data-testid={`restore-${t.id}`}>Restore</button>
                  <button className="btn btn--ghost btn--small" onClick={() => purge(t.id, t.name)} data-testid={`purge-${t.id}`}>Delete forever</button>
                </span>
              </div>
            ))}
            <div className="modal__row" style={{ marginTop: 14 }}><button className="btn" onClick={() => setShowTrash(false)}>Close</button></div>
          </div>
        </Modal>
      )}

      {sharing && (
        <ShareModal
          project={sharing}
          onClose={() => setSharing(null)}
          onSaved={(updated) => {
            setSharing(null);
            setProjects((cur) => cur?.map((p) => (p.id === updated.id ? { ...p, share: updated.share } : p)) ?? cur);
          }}
        />
      )}
      {showAccount && user && (
        <AccountSettings user={user} onClose={() => setShowAccount(false)} />
      )}
      {showGithub && (
        <GithubImport onClose={() => setShowGithub(false)} onImported={(id) => navigate(`/p/${id}`)} />
      )}
      {showOnboarding && (
        <Onboarding onNew={() => setCreating(true)} onGithub={() => setShowGithub(true)} onImportZip={importZip} onClose={dismissOnboarding} />
      )}

      {creating && (
        <Modal onClose={() => setCreating(false)} label="New project">
          <div>
            <h2>New project</h2>
            <p className="modal__sub">Name it, pick a starting point, start writing.</p>
            <input
              autoFocus
              className="input"
              placeholder="Project name"
              value={newName}
              data-testid="new-project-name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }}
            />
            {templates.length > 0 && (
              <div className="tpl-grid" data-testid="template-grid">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className={`tpl ${template === t.id ? 'tpl--active' : ''}`}
                    data-testid={`template-${t.id}`}
                    onClick={() => setTemplate(t.id)}
                    title={t.description}
                  >
                    <span className="tpl__icon">{t.icon || '📄'}</span>
                    <span className="tpl__name">{t.name}</span>
                    <span className="tpl__desc">{t.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="modal__row">
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={create} data-testid="create-project">Create</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
