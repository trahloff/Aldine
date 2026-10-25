import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, ReplaceResult, SearchMatch, SearchQuery, SearchResult } from '../api';
import { useDialogs } from './Dialogs';
import { useToast } from './Toast';
import { fileIcon, IconChevronRight, IconRefresh, IconReplace, IconX } from './Icons';
import { safeStorage } from '../util/safeStorage';

/** Match case / whole word / regex, remembered per browser; the query is not. */
const STORE = 'aldine.search';
type Toggles = Pick<SearchQuery, 'caseSensitive' | 'wholeWord' | 'regex'>;

function loadToggles(): Toggles {
  const v = safeStorage.getJSON<{ case?: unknown; word?: unknown; regex?: unknown } | null>(STORE, {});
  return { caseSensitive: v?.case === true, wholeWord: v?.word === true, regex: v?.regex === true };
}

function saveToggles(t: Toggles): void {
  safeStorage.setJSON(STORE, { case: t.caseSensitive, word: t.wholeWord, regex: t.regex });
}

const DEBOUNCE_MS = 300;
/** Every search runs in a worker on the server, one per person and four per
 *  server at a time: the one this replaced may still be finishing there. */
const BUSY = ['A search is still running', 'Too many searches are running'];
const SEED_MAX = 200;
/** A selection used as the query in regex mode must find itself: `\cite{x}` is no valid pattern. */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A focus request from the editor: the shortcut, the palette. `seed` is the editor's selection. */
export interface SearchFocus { n: number; seed?: string; field: 'query' | 'replace' }

interface Props {
  projectId: string;
  branch: string;
  rootFile?: string;
  /** The project commits by hand: replacements wait in History. */
  manual: boolean;
  /** Commit author without accounts (the browser's name); the server ignores it otherwise. */
  author?: string;
  focus: SearchFocus | null;
  onOpenMatch(path: string, m: SearchMatch, focusEditor: boolean): void;
  /** `deleted`: the replacement was empty. */
  onReplaced(res: ReplaceResult, deleted: boolean): void;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const shownPattern = (q: SearchQuery) => (q.regex ? `/${q.q}/` : q.q);

type Item =
  | { key: string; kind: 'file'; path: string }
  | { key: string; kind: 'match'; path: string; m: SearchMatch };

export default function SearchPanel({ projectId, branch, rootFile, manual, author, focus, onOpenMatch, onReplaced }: Props) {
  const dialogs = useDialogs();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [toggles, setToggles] = useState<Toggles>(loadToggles);
  // The results on screen and the query and branch they answer: a replace
  // sends that query, not whatever has been typed since, and never to
  // another branch.
  const [shown, setShown] = useState<{ query: SearchQuery; branch: string; result: SearchResult } | null>(null);
  /** The run whose answer (or error) is on screen. */
  const [settled, setSettled] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectReq, setSelectReq] = useState<{ n: number; field: 'query' | 'replace' } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where focus goes once the run after a replace has answered: the first row from item `at` on. */
  const refocus = useRef<{ n: number; at: number } | null>(null);
  const currentRef = useRef<SearchQuery>({ q: query, ...toggles });
  currentRef.current = { q: query, ...toggles };

  const run = useCallback((q: SearchQuery = currentRef.current, attempt = 0): number => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    abort.current?.abort();
    abort.current = null;
    const n = ++seq.current;
    if (!q.q) { setShown(null); setError(null); setSearching(false); setSettled(n); return n; }
    const ctl = new AbortController();
    abort.current = ctl;
    setSearching(true);
    api.search(projectId, branch, q, ctl.signal).then((result) => {
      if (n !== seq.current) return;
      setShown({ query: q, branch, result });
      setError(null);
      setSearching(false);
      setSettled(n);
    }, (err: unknown) => {
      if (n !== seq.current || ctl.signal.aborted) return;
      if (err instanceof ApiError && err.status === 429 && BUSY.some((b) => err.message.startsWith(b)) && attempt < 3) {
        timer.current = setTimeout(() => {
          const next = run(q, attempt + 1);
          if (refocus.current?.n === n) refocus.current = { ...refocus.current, n: next };
        }, DEBOUNCE_MS);
        return;
      }
      setShown(null);
      setError((err as Error)?.message || 'Search failed');
      setSearching(false);
      setSettled(n);
    });
    return n;
  }, [projectId, branch]);

  // Another branch is another set of files: nothing on screen still applies,
  // and an answer still on its way from the old one must not land.
  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    abort.current?.abort();
    abort.current = null;
    seq.current++;
    refocus.current = null;
    setShown(null);
    setError(null);
    setSearching(false);
    setCollapsed(new Set());
    setDismissed(new Set());
  }, [projectId, branch]);

  useEffect(() => {
    setDismissed(new Set());
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; run(); }, query ? DEBOUNCE_MS : 0);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [query, toggles, run]);

  useEffect(() => () => { abort.current?.abort(); }, []);

  useEffect(() => {
    if (!focus) return;
    if (focus.seed && !/[\r\n]/.test(focus.seed) && focus.seed.length <= SEED_MAX) setQuery(toggles.regex ? escapeRegex(focus.seed) : focus.seed);
    setSelectReq({ n: focus.n, field: focus.field });
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // Its own effect so it runs after the render that put a seed into the field.
  useEffect(() => {
    if (!selectReq) return;
    const el = selectReq.field === 'replace' ? replaceRef.current : queryRef.current;
    el?.focus();
    el?.select();
  }, [selectReq]);

  const setToggle = (k: keyof Toggles) => setToggles((t) => {
    const next = { ...t, [k]: !t[k] };
    saveToggles(next);
    return next;
  });

  const files = useMemo(() => (shown?.result.files ?? []).filter((f) => !dismissed.has(f.path)), [shown, dismissed]);
  const leftOut = (shown?.result.files.length ?? 0) - files.length;
  const total = files.reduce((n, f) => n + f.matches.length, 0);
  const truncated = shown?.result.truncated ?? null;
  // The tree's order: each file header, then its rows while it is expanded.
  const items: Item[] = useMemo(() => files.flatMap((f): Item[] => [
    { key: `f:${f.path}`, kind: 'file', path: f.path },
    ...(collapsed.has(f.path) ? [] : f.matches.map((m, i): Item => ({ key: `m:${i}:${f.path}`, kind: 'match', path: f.path, m }))),
  ]), [files, collapsed]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const tabStop = items.some((i) => i.key === cursor) ? cursor : items.find((i) => i.kind === 'match')?.key ?? items[0]?.key ?? null;

  const focusItem = (key: string) => {
    setCursor(key);
    itemRefs.current.get(key)?.focus();
  };
  const focusFirstMatch = () => {
    const first = items.find((i) => i.kind === 'match') ?? items[0];
    if (first) focusItem(first.key);
  };
  const setFolded = (path: string, folded: boolean) => setCollapsed((c) => {
    const next = new Set(c);
    if (folded) next.add(path); else next.delete(path);
    return next;
  });
  /** Leave a file out of the view and of Replace all; from the keyboard, focus moves on to the next file. */
  const dismiss = (path: string, moveFocus: boolean) => {
    setDismissed((d) => new Set(d).add(path));
    if (!moveFocus) return;
    const at = files.findIndex((f) => f.path === path);
    const next = files[at + 1] ?? files[at - 1];
    if (next) focusItem(`f:${next.path}`); else queryRef.current?.focus();
  };

  // A replace changes the rows under the focused one: focus goes to the row
  // now in its place, else the query field — unless the person has moved it
  // out of the panel meanwhile.
  useEffect(() => {
    const want = refocus.current;
    if (!want || want.n !== settled) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !panelRef.current?.contains(active)) return;
    const list = itemsRef.current;
    const next = list.slice(want.at).find((i) => i.kind === 'match') ?? list.slice(0, want.at).reverse().find((i) => i.kind === 'match');
    if (next) focusItem(next.key); else queryRef.current?.focus();
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const rerunAfterReplace = (at: number) => { refocus.current = { n: run(), at }; };

  const onItemKey = (e: React.KeyboardEvent, item: Item) => {
    if (e.target !== e.currentTarget) return; // the row's own buttons keep their keys
    const at = items.findIndex((i) => i.key === item.key);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (at + 1 < items.length) focusItem(items[at + 1].key);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (at > 0) focusItem(items[at - 1].key); else queryRef.current?.focus();
        break;
      case 'Home':
        e.preventDefault();
        if (items.length) focusItem(items[0].key);
        break;
      case 'End':
        e.preventDefault();
        if (items.length) focusItem(items[items.length - 1].key);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (item.kind === 'match') focusItem(`f:${item.path}`);
        else if (!collapsed.has(item.path)) setFolded(item.path, true);
        break;
      case 'ArrowRight':
        if (item.kind !== 'file') break;
        e.preventDefault();
        if (collapsed.has(item.path)) setFolded(item.path, false);
        else if (items[at + 1]?.kind === 'match') focusItem(items[at + 1].key);
        break;
      case 'Enter':
        // Keydown, so the browser's synthetic click (which would focus the editor) never fires.
        e.preventDefault();
        if (item.kind === 'match') onOpenMatch(item.path, item.m, false);
        else setFolded(item.path, !collapsed.has(item.path));
        break;
      case 'Delete':
      case 'Backspace':
        if (item.kind !== 'file') break;
        e.preventDefault();
        dismiss(item.path, true);
        break;
      case 'Escape':
        e.preventDefault();
        queryRef.current?.focus();
        break;
    }
  };

  const del = replacement === '';
  const replaceOne = async (path: string, m: SearchMatch) => {
    if (!shown || busy || shown.branch !== branch) return;
    const file = shown.result.files.find((f) => f.path === path);
    if (!file) return;
    const same = file.matches.filter((x) => x.text === m.text);
    const p = m.preview;
    const alike = same.filter((x) => x.preview.text === p.text && x.preview.start === p.start && x.preview.end === p.end).length;
    const at = items.findIndex((i) => i.kind === 'match' && i.m === m);
    setBusy(true);
    try {
      const target = { path, text: m.text, preview: m.preview, ordinal: same.indexOf(m), count: same.length, alike };
      onReplaced(await api.replace(projectId, branch, shown.query, replacement, { match: target }, author), del);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast('That match changed — results updated');
      else toast(`Could not ${del ? 'delete' : 'replace'}: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
      rerunAfterReplace(Math.max(0, at));
    }
  };

  const canReplaceAll = !!shown && shown.branch === branch && files.length > 0 && !busy && !truncated;
  const replaceAll = async () => {
    if (!shown || !canReplaceAll) return;
    const q = shown.query;
    const names = files.map((f) => f.path);
    const where = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    const ok = await dialogs.confirm({
      title: `${del ? 'Delete' : 'Replace'} ${count(total, 'match', 'matches')} in ${count(files.length, 'file')}?`,
      body: `${del ? shownPattern(q) : `${shownPattern(q)} → ${replacement}`}, in ${where}. ${manual ? 'The changes wait in History for your commit.' : 'This lands as one commit.'}`,
      confirmLabel: del ? 'Delete matches' : 'Replace all',
      danger: del,
    });
    if (!ok) return;
    setBusy(true);
    try {
      onReplaced(await api.replace(projectId, branch, q, replacement, { paths: names }, author), del);
    } catch (err) {
      toast(`Could not ${del ? 'delete' : 'replace'}: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
      rerunAfterReplace(0);
    }
  };

  const diff = !!shown && !shown.query.regex && !del;
  const large = shown?.result.skipped.large ?? [];
  const largeCount = shown?.result.skipped.largeCount ?? large.length;
  const longMatches = shown?.result.skipped.longMatches ?? 0;
  const truncatedNote = truncated === 'matches'
    ? 'Showing the first 2,000 results — narrow the search to see the rest'
    : truncated === 'bytes' ? 'Stopped after 8 MB of text — narrow the search to see the rest' : '';
  const largeNote = largeCount > 0 ? `${count(largeCount, 'file')} over 1 MB ${largeCount === 1 ? 'was' : 'were'} not searched` : '';
  const longNote = longMatches > 0 ? `${count(longMatches, 'match', 'matches')} longer than 1,000 characters ${longMatches === 1 ? 'is' : 'are'} not shown` : '';
  const summary = `${count(total, 'result')} in ${count(files.length, 'file')}`;
  // What a screen reader hears once a search has answered. The visible status
  // line comes and goes with the results, so it cannot be the live region.
  const announcement = !query || searching || !shown ? ''
    : shown.result.files.length === 0 ? `No results for “${shown.query.q}”`
      : [summary, leftOut ? `${count(leftOut, 'file')} left out` : '', truncatedNote, largeNote, longNote].filter(Boolean).join('. ');
  const replaceAllTitle = truncated === 'matches' ? 'Too many matches to replace at once — narrow the search'
    : truncated === 'bytes' ? 'Too much text searched to replace at once — narrow the search'
      : manual ? 'Replace every match shown; the changes wait in History for your commit' : 'Replace every match shown, as one commit';
  const setRef = (key: string) => (el: HTMLElement | null) => { if (el) itemRefs.current.set(key, el); else itemRefs.current.delete(key); };

  return (
    <div ref={panelRef} className="search" data-testid="search-panel">
      <div className="search__live" role="status" aria-live="polite" data-testid="search-status">{announcement}</div>
      <div className="search__field">
        <input
          ref={queryRef}
          className="input search__input"
          type="text"
          value={query}
          placeholder="Search the project"
          aria-label="Search the project"
          spellCheck={false}
          autoComplete="off"
          data-testid="search-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); run(); }
            else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); focusFirstMatch(); }
          }}
        />
        <span className="search__toggles">
          <button className="search__toggle" aria-pressed={toggles.caseSensitive} title="Match case" aria-label="Match case" data-testid="search-case" onClick={() => setToggle('caseSensitive')}>Aa</button>
          <button className="search__toggle search__toggle--word" aria-pressed={toggles.wholeWord} title="Whole word" aria-label="Whole word" data-testid="search-word" onClick={() => setToggle('wholeWord')}>ab</button>
          <button className="search__toggle search__toggle--mono" aria-pressed={toggles.regex} title="Regular expression" aria-label="Regular expression" data-testid="search-regex" onClick={() => setToggle('regex')}>.*</button>
        </span>
      </div>
      <div className="search__replace">
        <input
          ref={replaceRef}
          className="input search__input"
          type="text"
          value={replacement}
          placeholder="Replace with"
          aria-label="Replace with"
          spellCheck={false}
          autoComplete="off"
          data-testid="search-replace-input"
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void replaceAll(); } }}
        />
        {/* aria-disabled, not disabled: the confirm hands focus back to this button as it closes */}
        <button
          className="btn btn--small"
          aria-disabled={!canReplaceAll}
          title={replaceAllTitle}
          data-testid="search-replace-all"
          onClick={() => void replaceAll()}
        >
          Replace all
        </button>
      </div>

      {query && (searching || (shown && shown.result.files.length > 0)) && (
        <div className="search__status">
          <span className="search__summary" data-testid="search-summary">{searching ? 'Searching…' : summary}</span>
          {!searching && leftOut > 0 && (
            <button className="search__link" data-testid="search-show-left-out" onClick={() => setDismissed(new Set())}>
              Show {count(leftOut, 'left-out file')}
            </button>
          )}
          <button className="search__refresh" title="Search again" aria-label="Search again" data-testid="search-refresh" onClick={() => run()}><IconRefresh /></button>
        </div>
      )}
      {error && <div className="search__error" role="alert" data-testid="search-error">{error}</div>}
      {truncatedNote && <div className="search__note" data-testid="search-truncated">{truncatedNote}</div>}
      {(largeNote || longNote) && (
        <div className="search__note" data-testid="search-skipped">
          {largeNote && (
            <details className="search__large">
              <summary>{largeNote}</summary>
              <ul data-testid="search-skipped-files">
                {large.map((name) => <li key={name}>{name}</li>)}
                {largeCount > large.length && <li>and {(largeCount - large.length).toLocaleString('en-US')} more</li>}
              </ul>
            </details>
          )}
          {longNote && <span>{longNote}.</span>}
        </div>
      )}
      {!query && <p className="search__empty" data-testid="search-empty">Searches every text file on this branch. Build output, hidden files and files over 1 MB are skipped.</p>}
      {query && !searching && !error && shown && shown.result.files.length === 0 && (
        <p className="search__empty" data-testid="search-empty">No results for “{shown.query.q}”</p>
      )}

      {files.length > 0 && (
        <div className="search__results" role="tree" aria-label="Search results" data-testid="search-results">
          {files.map((f) => {
            const open = !collapsed.has(f.path);
            const slash = f.path.lastIndexOf('/');
            const headKey = `f:${f.path}`;
            const fileItem: Item = { key: headKey, kind: 'file', path: f.path };
            // The whole file is the treeitem and owns its group of rows; the
            // header inside it is what it shows and what a click toggles.
            return (
              <div
                key={f.path}
                ref={setRef(headKey)}
                className="search__file"
                role="treeitem"
                aria-expanded={open}
                aria-label={`${f.path}, ${count(f.matches.length, 'result')}`}
                aria-keyshortcuts="Delete"
                tabIndex={tabStop === headKey ? 0 : -1}
                data-testid="search-file"
                data-path={f.path}
                onFocus={(e) => { if (e.target === e.currentTarget) setCursor(headKey); }}
                onKeyDown={(e) => onItemKey(e, fileItem)}
              >
                <div className="search__file-head" title={f.path} data-testid="search-file-toggle" onClick={() => setFolded(f.path, open)}>
                  <span className={`search__chev${open ? ' search__chev--open' : ''}`}><IconChevronRight /></span>
                  <span className="tree__icon">{fileIcon(f.path, f.path === rootFile)}</span>
                  <span className="search__file-name">{slash < 0 ? f.path : f.path.slice(slash + 1)}</span>
                  {slash >= 0 && <span className="search__file-dir">{f.path.slice(0, slash)}</span>}
                  <span className="search__file-count" data-testid="search-file-count">{f.matches.length}</span>
                  {/* Delete on the focused file does the same from the keyboard */}
                  <button
                    className="search__icon-btn search__file-dismiss"
                    title="Leave this file out"
                    aria-label={`Leave ${f.path} out`}
                    tabIndex={-1}
                    data-testid="search-file-dismiss"
                    onClick={(e) => { e.stopPropagation(); dismiss(f.path, false); }}
                  >
                    <IconX />
                  </button>
                </div>
                {open && (
                  <div role="group">
                    {f.matches.map((m, i) => {
                      const key = `m:${i}:${f.path}`;
                      const { text, start, end } = m.preview;
                      return (
                        <div
                          key={key}
                          ref={setRef(key)}
                          className="search__match"
                          role="treeitem"
                          tabIndex={tabStop === key ? 0 : -1}
                          title={`${f.path}:${m.line}`}
                          data-testid="search-match"
                          data-path={f.path}
                          data-line={m.line}
                          onClick={() => { setCursor(key); onOpenMatch(f.path, m, true); }}
                          onKeyDown={(e) => onItemKey(e, { key, kind: 'match', path: f.path, m })}
                        >
                          <span className="search__line" data-testid="search-match-line">{m.line}</span>
                          <span className="search__preview">
                            {text.slice(0, start)}
                            {diff
                              ? <><del>{text.slice(start, end)}</del><ins>{replacement}</ins></>
                              : <mark className={del ? 'search__mark--delete' : undefined}>{text.slice(start, end)}</mark>}
                            {text.slice(end)}
                          </span>
                          <button
                            className="search__icon-btn search__replace-one"
                            title={del ? 'Delete this match' : 'Replace this match'}
                            aria-label={del ? 'Delete this match' : 'Replace this match'}
                            tabIndex={tabStop === key ? 0 : -1}
                            aria-disabled={busy}
                            data-testid="search-replace-one"
                            onClick={(e) => { e.stopPropagation(); void replaceOne(f.path, m); }}
                          >
                            {del ? <IconX /> : <IconReplace />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
