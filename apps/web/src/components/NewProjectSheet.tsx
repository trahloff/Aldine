import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, TemplateInfo, TemplateRepoState } from '../api';
import Modal from './Modal';
import NamespacePicker from './NamespacePicker';
import { useToast } from './Toast';
import { IconPlus, IconRefresh, IconSearch, IconX } from './Icons';
import { pickTemplate, templateToPost } from '../util/templates';
import { ALL, galleryGroups, moveInGrid, railEntries, repoIdOf, shownTemplates } from '../util/templateChooser';

export interface NewProjectSheetProps {
  onClose: () => void;
  /** Template id to start on, e.g. from a template sheet on the empty Home. The name field takes focus either way. */
  template?: string;
  /** The server provisions new projects on GitLab: the group picker is shown. */
  provisioning?: boolean;
  /** Opens the ZIP import: a kit the publisher only hands to a browser is imported, not created. */
  onImportZip?: () => void;
}

const DEFAULT_NAME = 'Untitled project';
/** A phone layout: the rail is a row, and focusing an input raises the on-screen keyboard over the gallery. */
const PHONE_QUERY = '(max-width: 640px), (pointer: coarse)';
const RAIL_ROW_QUERY = '(max-width: 640px)';

function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** A printable key with no command modifier: what typeahead sends to the search. */
const printable = (e: ReactKeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ';

function Preview({ t }: { t: TemplateInfo }) {
  const [failed, setFailed] = useState(false);
  const ratio = t.preview ? `${t.preview.w} / ${t.preview.h}` : '210 / 297';
  if (t.id === 'blank') {
    return (
      <span className="tpl__paper tpl__paper--blank" style={{ aspectRatio: ratio }} aria-hidden="true">
        <IconPlus width={22} height={22} />
      </span>
    );
  }
  if (t.preview && !failed) {
    return (
      <span className="tpl__paper" style={{ aspectRatio: ratio }} aria-hidden="true">
        <img
          className="tpl__img"
          src={api.templatePreviewUrl(t.id, t.preview.v)}
          width={t.preview.w}
          height={t.preview.h}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          data-testid={`template-preview-${t.id}`}
        />
      </span>
    );
  }
  // A title page drawn in CSS: a venue whose class is never typeset here, or
  // a template whose first typeset has not finished.
  return (
    <span className="tpl__paper tpl__paper--placeholder" style={{ aspectRatio: ratio }} aria-hidden="true" data-testid={`template-placeholder-${t.id}`}>
      <span className="tpl__ph-title">{t.name}</span>
      <span className="tpl__ph-rule" />
      <span className="tpl__ph-line" />
      <span className="tpl__ph-line tpl__ph-line--short" />
      <span className="tpl__ph-folio">1</span>
    </span>
  );
}

/**
 * The New project chooser: a category rail, a search, page-1 previews of
 * every template, and the project name in the footer, prefilled and
 * selected so Enter creates. On a phone Modal turns it into a bottom sheet.
 */
export default function NewProjectSheet({ onClose, template: preselected, provisioning, onImportZip }: NewProjectSheetProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [repoStates, setRepoStates] = useState<TemplateRepoState[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [template, setTemplate] = useState(preselected ?? 'article');
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState(ALL);
  const [name, setName] = useState(DEFAULT_NAME);
  // Undefined until the namespace picker loads, i.e. while the server has no
  // GitLab provisioning: nothing is sent and no GitLab toast is shown.
  const [namespace, setNamespace] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Read once at open: the sheet does not move focus again if the window is resized.
  const [touchFirst] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches);
  const railRow = useMedia(RAIL_ROW_QUERY);
  const nameSelected = useRef(!touchFirst);
  const [announce, setAnnounce] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Repositories sync in the background after boot, so the list is read each
  // time the chooser opens. The repo states are informational: a server
  // without the route still gets its gallery.
  useEffect(() => {
    let live = true;
    api.templateRepos().then((r) => { if (live) setRepoStates(r.repos); }).catch(() => { if (live) setRepoStates([]); });
    api.templates().then((list) => {
      if (!live) return;
      setTemplates(list);
      setTemplate((cur) => pickTemplate(list, cur));
    }).catch(() => { if (live) setTemplates([]); });
    return () => { live = false; };
  }, []);

  // A preselected tile can sit far down the list: bring it on screen once
  // the list is in, without taking focus from the name field.
  const scrolledToPreselected = useRef(false);
  useEffect(() => {
    if (!preselected || !templates?.length || scrolledToPreselected.current) return;
    scrolledToPreselected.current = true;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-template="${CSS.escape(pickTemplate(templates, preselected))}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [templates, preselected]);

  const all = templates ?? [];
  const rails = useMemo(() => railEntries(galleryGroups(all, repoStates)), [all, repoStates]);
  const railKey = rails.some((r) => r.key === rail) ? rail : ALL;
  const shown = useMemo(() => shownTemplates(all, repoStates, railKey, query), [all, repoStates, railKey, query]);
  const groups = useMemo(() => galleryGroups(shown, repoStates), [shown, repoStates]);
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // A search or a rail pick that hides the chosen tile would leave Create
  // acting on something the user cannot see, so the first tile on screen
  // becomes the choice. When the choice is still on screen, it stands.
  const effective = ordered.some((t) => t.id === template) ? template : ordered[0]?.id ?? template;
  const chosen = all.find((t) => t.id === effective) ?? null;
  // The publisher answers a server's download with a browser challenge: the
  // user fetches the kit and imports it, and Create is not offered.
  const manualKit = chosen?.kit?.manual ? chosen.kit : null;

  // The choice line is not live: focus already names a tile the arrows move
  // to. A search moves the choice without moving focus, so it is announced.
  useEffect(() => {
    if (!query || templates === null) { setAnnounce(''); return; }
    setAnnounce(ordered.length
      ? `${ordered.length} ${ordered.length === 1 ? 'template matches' : 'templates match'}. Starting from ${chosen?.name ?? 'the built-in article'}.`
      : 'No template matches.');
  }, [query, ordered.length, chosen?.name, templates === null]);

  const importKit = () => {
    onImportZip?.();
    onClose();
  };

  const create = async () => {
    if (manualKit) { if (onImportZip) importKit(); return; }
    if (submitting) return;
    const projectName = name.trim() || DEFAULT_NAME;
    setSubmitting(true);
    try {
      const p = await api.createProject(projectName, undefined, templateToPost(all, effective), namespace);
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

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { repos } = await api.refreshTemplateRepos();
      setRepoStates(repos);
      const list = await api.templates();
      setTemplates(list);
      setTemplate((cur) => pickTemplate(list, cur));
      const bad = repos.filter((r) => !r.ok);
      if (bad.length) toast(`Could not refresh ${bad.map((r) => r.label).join(', ')}: ${bad[0].error ?? 'unknown error'}`, 'error');
    } catch (err: any) {
      toast(`Could not refresh templates: ${err.message}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const tiles = () => Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
  const focusTile = (id: string) => {
    const el = tiles().find((b) => b.dataset.template === id);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };

  const typeahead = (e: ReactKeyboardEvent) => {
    if (!printable(e)) return false;
    e.preventDefault();
    setQuery((q) => q + e.key);
    setRail(ALL);
    searchRef.current?.focus();
    return true;
  };

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || typeahead(e)) return;
    const buttons = tiles();
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    if (e.key === 'Enter') { e.preventDefault(); create(); return; }
    const to = moveInGrid(buttons.map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; }), from, e.key);
    if (to < 0) {
      // Past the top row the search is next; at any other edge the key does nothing, not scroll.
      if (e.key.startsWith('Arrow')) e.preventDefault();
      if (e.key === 'ArrowUp') searchRef.current?.focus();
      return;
    }
    e.preventDefault();
    const id = buttons[to].dataset.template!;
    setTemplate(id);
    focusTile(id);
  };

  const onRailKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || typeahead(e)) return;
    const at = rails.findIndex((r) => r.key === railKey);
    let to = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = Math.min(rails.length - 1, at + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = Math.max(0, at - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = rails.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setRail(rails[to].key);
    railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
    gridRef.current?.scrollTo?.({ top: 0 });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); create(); return; }
    if (e.key === 'ArrowDown' && ordered.length) { e.preventDefault(); setTemplate(effective); focusTile(effective); }
  };

  const choiceText = templates !== null && templates.length > 0 ? (
    <>
      Starting from {chosen ? chosen.name : 'the built-in article'}
      {chosen?.license ? ` (${chosen.license})` : ''}
      {manualKit
        ? `. ${manualKit.host} does not allow automated downloads: download the kit there, then import the ZIP.`
        : chosen?.kit ? `. Aldine downloads the official kit from ${chosen.kit.host} when you create the project.` : ''}
    </>
  ) : null;

  return (
    <Modal onClose={onClose} label="New project" className="modal--chooser" testId="new-project-sheet" initialFocus={touchFirst ? headingRef : nameRef}>
      <div className="chooser">
        <header className="chooser__head">
          <h2 ref={headingRef} tabIndex={-1} className="chooser__title">New project</h2>
          <div className="tpl-search">
            <span className="tpl-search__icon" aria-hidden="true"><IconSearch /></span>
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="Search templates, for example IEEE or NeurIPS"
              aria-label="Search templates"
              aria-controls="template-grid"
              value={query}
              data-testid="template-search"
              onChange={(e) => { setQuery(e.target.value); if (e.target.value) setRail(ALL); }}
              onKeyDown={onSearchKey}
            />
            {/* Escape belongs to the dialog: the sheet closes on it. */}
            {query && (
              <button className="tpl-search__clear" aria-label="Clear the template search" data-testid="template-search-clear"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                <IconX />
              </button>
            )}
          </div>
        </header>

        <div className="chooser__body">
          <div className="chooser__side">
            <div className="chooser__rail" ref={railRef} role="tablist" aria-orientation={railRow ? 'horizontal' : 'vertical'} aria-label="Template categories" data-testid="template-rail" onKeyDown={onRailKey}>
              {rails.map((r) => (
                <button
                  key={r.key}
                  role="tab"
                  aria-selected={railKey === r.key}
                  aria-controls="template-grid"
                  tabIndex={railKey === r.key ? 0 : -1}
                  className="chooser__rail-item"
                  data-testid={`template-rail-${r.key}`}
                  onClick={() => { setRail(r.key); gridRef.current?.scrollTo?.({ top: 0 }); }}
                >
                  <span className="chooser__rail-label">{r.label}</span>
                  <span className="chooser__rail-count">{r.count}</span>
                </button>
              ))}
            </div>
            {repoStates.length > 0 && (
              <button className="btn btn--ghost btn--small chooser__refresh" onClick={refresh} disabled={refreshing} data-testid="template-refresh">
                <IconRefresh /> {refreshing ? 'Refreshing…' : 'Refresh templates'}
              </button>
            )}
          </div>

          <div className="tpl-gallery" id="template-grid" ref={gridRef} role="tabpanel" aria-label="Templates" data-testid="template-grid">
            {templates === null && <p className="tpl-empty" role="status">Loading templates…</p>}
            {templates !== null && templates.length > 0 && !ordered.length && (
              <p className="tpl-empty" data-testid="template-empty">No template matches that. Create still starts from {chosen ? chosen.name : 'the built-in article'}.</p>
            )}
            {groups.length > 0 && (
              <div role="listbox" aria-label="Templates" className="tpl-list" onKeyDown={onGridKey}>
                {groups.map((g) => (
                  <div key={g.key} role="group" className="tpl-group" data-testid={g.testid} aria-labelledby={`tpl-group-${g.key}`}>
                    <h3 className="tpl-group__label" id={`tpl-group-${g.key}`}>
                      {g.heading}
                      {g.stale && <span className="tpl-group__stale" data-testid={`template-repo-stale-${g.stale.repoId}`}>{g.stale.text}</span>}
                    </h3>
                    <div className="tpl-grid">
                      {g.items.map((t) => {
                        const active = effective === t.id;
                        return (
                          <button
                            key={t.id}
                            className={`tpl${active ? ' tpl--active' : ''}`}
                            role="option"
                            aria-selected={active}
                            tabIndex={active ? 0 : -1}
                            data-testid={`template-${t.id}`}
                            data-template={t.id}
                            onClick={() => setTemplate(t.id)}
                            onDoubleClick={() => { setTemplate(t.id); if (!t.kit?.manual) create(); }}
                            title={t.description}
                          >
                            <Preview t={t} />
                            <span className="tpl__name">{t.name}</span>
                            {t.description && <span className="tpl__desc">{t.description}</span>}
                            {/* The kit is downloaded when the project is created, not now:
                                say so before the user picks the tile. */}
                            {t.kit && (
                              <span className="tpl__kit" data-testid={`template-kit-${t.id}`}>
                                {t.kit.manual ? `Download the kit from ${t.kit.host}, then import the ZIP` : `Downloads the official kit from ${t.kit.host}`}
                              </span>
                            )}
                            {(t.license || t.source?.kind === 'repo') && (
                              <span className="tpl__meta">
                                {t.license && <span className="tpl__license" data-testid={`template-license-${t.id}`}>{t.license}</span>}
                                {t.source?.kind === 'repo' && <span className="tpl__source" data-testid={`template-source-${t.id}`}>{t.source.label ?? repoIdOf(t)}</span>}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="chooser__foot">
          {provisioning && <div className="chooser__ns"><NamespacePicker value={namespace} onChange={setNamespace} /></div>}
          <div className="chooser__name">
            <label className="field__label" htmlFor="new-project-name">Project name</label>
            <input
              ref={nameRef}
              id="new-project-name"
              className="input"
              value={name}
              data-testid="new-project-name"
              autoComplete="off"
              onFocus={(e) => {
                // On a phone the name is not selected at open; the first tap selects it.
                if (nameSelected.current) return;
                nameSelected.current = true;
                e.currentTarget.select();
              }}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); create(); } }}
            />
          </div>
          {choiceText && <p className="tpl-choice" data-testid="template-choice">{choiceText}</p>}
          <span className="visually-hidden" role="status" data-testid="template-announce">{announce}</span>
          <div className="chooser__actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            {manualKit ? (
              <>
                <a className={`btn${onImportZip ? '' : ' btn--primary'}`} href={manualKit.url} target="_blank" rel="noopener noreferrer" data-testid="kit-download">Download the kit</a>
                {onImportZip && <button className="btn btn--primary" onClick={importKit} data-testid="kit-import-zip">Import the ZIP</button>}
              </>
            ) : (
              <button className="btn btn--primary" onClick={create} disabled={submitting} data-testid="create-project">{submitting ? 'Creating…' : 'Create'}</button>
            )}
          </div>
        </footer>
      </div>
    </Modal>
  );
}
