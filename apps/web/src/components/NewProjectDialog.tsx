import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, RemoteInfo, TemplateCategory, TemplateInfo, TemplateRepoState } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';
import NamespacePicker from './NamespacePicker';
import { IconX } from './Icons';
import { friendlyDate } from '../util/dates';
import { pickTemplate, templateToPost } from '../util/templates';

/** Gallery order; a category with no template in it is not drawn. */
const TEMPLATE_CATEGORIES: TemplateCategory[] = ['General', 'Journals', 'Conferences', 'Theses', 'Slides'];

function matchesQuery(t: TemplateInfo, q: string): boolean {
  const hay = [t.name, t.description, t.category, t.documentClass, t.id, t.kit?.host, t.source?.label].join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Template ids from a repository are `repo:<repoId>/<folder>`. */
function repoIdOf(t: TemplateInfo): string {
  return t.id.slice('repo:'.length).split('/')[0];
}

interface GalleryGroup {
  key: string;
  testid: string;
  heading: string;
  /** Set on a repository whose last refresh failed while its previous checkout is still listed. */
  stale?: { repoId: string; text: string };
  items: TemplateInfo[];
}

/** Built-in categories in TEMPLATE_CATEGORIES order, with one group per
 *  repository (in config order) between 'General' and the venue categories.
 *  Repository templates are never placed in a category group. */
function galleryGroups(shown: TemplateInfo[], repos: TemplateRepoState[]): GalleryGroup[] {
  const byRepo = new Map<string, TemplateInfo[]>();
  for (const t of shown) {
    if (t.source?.kind !== 'repo') continue;
    const id = repoIdOf(t);
    byRepo.set(id, [...(byRepo.get(id) ?? []), t]);
  }
  const repoOrder = [...repos.map((r) => r.id), ...byRepo.keys()].filter((id, i, all) => all.indexOf(id) === i);
  const repoGroups: GalleryGroup[] = [];
  for (const repoId of repoOrder) {
    const items = byRepo.get(repoId);
    if (!items?.length) continue;
    const state = repos.find((r) => r.id === repoId);
    const stale = state && !state.ok && state.available
      ? { repoId, text: state.syncedAt ? `last updated ${friendlyDate(state.syncedAt)}, refresh failed` : 'refresh failed' }
      : undefined;
    repoGroups.push({
      key: `repo:${repoId}`,
      testid: `template-category-repo-${repoId}`,
      heading: state?.label ?? items[0].source?.label ?? repoId,
      stale,
      items,
    });
  }
  const out: GalleryGroup[] = [];
  for (const cat of TEMPLATE_CATEGORIES) {
    const items = shown.filter((t) => t.source?.kind !== 'repo' && (t.category || 'General') === cat);
    if (items.length) out.push({ key: cat, testid: `template-category-${cat}`, heading: cat, items });
    if (cat === 'General') out.push(...repoGroups);
  }
  return out;
}

/**
 * New project: a name, a starting point from the template gallery, and the
 * GitLab group when the server provisions there. `initialTemplate` is the
 * starting point picked before the dialog opened (a template sheet on the
 * empty project list); the name field has focus, so Enter creates.
 */
export default function NewProjectDialog({ onClose, remotes, initialTemplate }: {
  onClose(): void;
  remotes: RemoteInfo[];
  initialTemplate?: string;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [repoStates, setRepoStates] = useState<TemplateRepoState[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [template, setTemplate] = useState(initialTemplate || 'article');
  const [templateQuery, setTemplateQuery] = useState('');
  // Undefined until the namespace picker loads, i.e. while the server has no
  // GitLab provisioning: nothing is sent and no GitLab toast is shown.
  const [namespace, setNamespace] = useState<string | undefined>(undefined);

  // Repositories sync in the background after boot, so each opening asks
  // again for what has arrived since the page loaded. The repo list is
  // informational: a server without the route still gets its gallery.
  useEffect(() => {
    api.templateRepos().then((r) => setRepoStates(r.repos)).catch(() => setRepoStates([]));
    api.templates().then((list) => {
      setTemplates(list);
      setTemplate((cur) => pickTemplate(list, cur));
    }).catch(() => setTemplates([]));
  }, []);
  // A starting point picked outside the dialog may sit below the gallery's fold.
  useEffect(() => {
    if (!initialTemplate || !templates) return;
    const tile = document.querySelector(`[data-testid="template-${CSS.escape(initialTemplate)}"]`);
    tile?.scrollIntoView({ block: 'nearest' });
  }, [templates, initialTemplate]);

  const refreshTemplates = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { repos } = await api.refreshTemplateRepos();
      setRepoStates(repos);
      const list = await api.templates();
      setTemplates(list);
      setTemplate((cur) => pickTemplate(list, cur));
      const failed = repos.filter((r) => !r.ok);
      if (failed.length) {
        toast(`Could not refresh ${failed.map((r) => r.label).join(', ')}: ${failed[0].error ?? 'unknown error'}`, 'error');
      }
    } catch (err: any) {
      toast(`Could not refresh templates: ${err.message}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  // A search that hides the chosen tile would leave Create acting on something
  // the user cannot see, so the first result of a narrowing search becomes the
  // choice. With no search, or when the choice is still on screen, it stands.
  const shownTemplates = (() => {
    const q = templateQuery.trim().toLowerCase();
    if (!templates) return [] as TemplateInfo[];
    return q ? templates.filter((t) => matchesQuery(t, q)) : templates;
  })();
  const effectiveTemplate = shownTemplates.some((t) => t.id === template)
    ? template
    : shownTemplates[0]?.id ?? template;
  const chosen = templates?.find((t) => t.id === effectiveTemplate) ?? null;
  const close = () => { setTemplateQuery(''); onClose(); };

  // One request per click: a venue kit takes seconds to download, and a
  // double-click or a held Enter used to make two identical projects and
  // land in the second.
  const [submitting, setSubmitting] = useState(false);
  const create = async () => {
    if (submitting) return;
    const name = newName.trim() || 'Untitled project';
    setSubmitting(true);
    try {
      const p = await api.createProject(name, undefined, templateToPost(templates ?? [], effectiveTemplate), namespace);
      if (p.venueKit && !p.venueKit.ok) {
        toast(`Could not download the ${p.venueKit.name} kit from ${p.venueKit.host}. The project was created from a skeleton; README-venue.md says where to get the kit.`, 'error');
      }
      // Provisioning never blocks the project: a failure is a warning and the
      // editor offers a retry.
      if (p.remoteError) toast(p.remoteError, 'error');
      else if (p.remote && namespace) toast(`Also created on GitLab in ${p.remote.owner}`, 'ok');
      navigate(`/p/${p.id}`);
    } catch (err: any) {
      toast(`Could not create project: ${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={close} label="New project">
      <div>
        <h2>New project</h2>
        <p className="modal__sub">Name it, pick a starting point, start writing.</p>
        <label className="field__label" htmlFor="new-project-name">Project name</label>
        <input
          autoFocus
          id="new-project-name"
          className="input"
          placeholder="Untitled project"
          value={newName}
          data-testid="new-project-name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) create(); }}
        />
        {remotes.some((r) => r.provisioning) && <NamespacePicker value={namespace} onChange={setNamespace} />}
        {templates === null && <p className="tpl-empty">Loading templates…</p>}
        {templates !== null && templates.length > 0 && (
          <>
            <div className="tpl-search">
              <input
                className="input"
                placeholder="Search templates, for example IEEE or NeurIPS"
                aria-label="Search templates"
                value={templateQuery}
                data-testid="template-search"
                onChange={(e) => setTemplateQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); create(); } }}
              />
              {/* Escape belongs to the dialog: the modal closes on it before
                  any handler here could clear the query. */}
              {templateQuery && (
                <button
                  className="tpl-search__clear"
                  aria-label="Clear the template search"
                  data-testid="template-search-clear"
                  onClick={() => setTemplateQuery('')}
                >
                  <IconX />
                </button>
              )}
            </div>
            {repoStates.length > 0 && (
              <div className="tpl-toolbar">
                <button
                  className="btn btn--small"
                  onClick={refreshTemplates}
                  disabled={refreshing}
                  data-testid="template-refresh"
                >
                  {refreshing ? 'Refreshing…' : 'Refresh templates'}
                </button>
              </div>
            )}
            <div className="tpl-gallery" data-testid="template-grid">
              {(() => {
                const shown = shownTemplates;
                if (!shown.length) {
                  return <p className="tpl-empty" data-testid="template-empty">No template matches that. Create still starts from {chosen ? chosen.name : 'the built-in article'}.</p>;
                }
                return galleryGroups(shown, repoStates).map((g) => (
                  <div key={g.key} className="tpl-group" data-testid={g.testid}>
                    <div className="tpl-group__label">
                      {g.heading}
                      {g.stale && (
                        <span className="tpl-group__stale" data-testid={`template-repo-stale-${g.stale.repoId}`}>
                          {g.stale.text}
                        </span>
                      )}
                    </div>
                    <div className="tpl-grid">
                      {g.items.map((t) => (
                        <button
                          key={t.id}
                          className={`tpl ${effectiveTemplate === t.id ? 'tpl--active' : ''}`}
                          aria-pressed={effectiveTemplate === t.id}
                          data-testid={`template-${t.id}`}
                          onClick={() => setTemplate(t.id)}
                          title={t.description}
                        >
                          <span className="tpl__icon">{t.icon || '📄'}</span>
                          <span className="tpl__name">{t.name}</span>
                          <span className="tpl__desc">{t.description}</span>
                          {/* The kit is downloaded when the project is created, not now:
                              say so before the user picks the tile. */}
                          {t.kit && (
                            <span className="tpl__kit" data-testid={`template-kit-${t.id}`}>
                              Downloads the official kit from {t.kit.host}
                            </span>
                          )}
                          {t.license && <span className="tpl__license" data-testid={`template-license-${t.id}`}>{t.license}</span>}
                          {t.source?.kind === 'repo' && (
                            <span className="tpl__source" data-testid={`template-source-${t.id}`}>
                              {t.source.label ?? repoIdOf(t)}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
              ));
              })()}
            </div>
          </>
        )}
        <div className="modal__row">
          {templates !== null && templates.length > 0 && (
            <p className="tpl-choice" data-testid="template-choice" aria-live="polite">
              Starting from {chosen ? chosen.name : 'the built-in article'}
              {chosen?.license ? ` (${chosen.license})` : ''}
              {chosen?.kit ? `. Aldine downloads the official kit from ${chosen.kit.host} when you create the project.` : ''}
            </p>
          )}
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn--primary" onClick={create} disabled={submitting} data-testid="create-project">{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </Modal>
  );
}
