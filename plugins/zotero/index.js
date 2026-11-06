/**
 * Aldine Zotero plugin — vanilla-DOM sidebar panel.
 * Link a Zotero library (API key, kept with the account), pick a
 * library/collection, keep a .bib in sync, and insert \cite{...} while writing.
 */

/** A sync on open when the last one is older than this. */
const STALE_SECONDS = 3600;

/** What the toast says after a citation pick (aldine.editor.insertCitation). */
function citeToast(aldine, key, result) {
  if (result === 'added') aldine.toast(`Added ${key} to the citation`, 'ok');
  else if (result === 'present') aldine.toast(`${key} is in this citation already`, 'ok');
  else if (result) aldine.toast(`Inserted \\cite{${key}}`, 'ok');
  else aldine.toast(`Open a .tex file and put the cursor where \\cite{${key}} goes`, 'error');
}

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
};

export default {
  activate(aldine) {
    // The panel's own actions, for the palette commands; set once it renders.
    let panel = null;
    aldine.ui.registerCommand?.({
      id: 'zotero-open', group: 'References', title: 'Zotero: import or cite from your library', keywords: 'zotero bibliography references import cite',
      run: () => aldine.ui.showPanel('zotero'),
    });
    aldine.ui.registerCommand?.({
      id: 'zotero-sync', group: 'References', title: 'Zotero: sync the library now', keywords: 'zotero bibliography references refresh update',
      run: () => { aldine.ui.showPanel('zotero'); panel?.syncNow(); },
    });
    aldine.ui.registerSidebarPanel({
      id: 'zotero',
      title: 'Zotero',
      render(root) {
        const state = {
          view: 'loading', // loading | connect | pick | linked
          apiKey: '',
          userID: null,
          username: '',
          groups: [],
          collections: [],
          libraryPrefix: '',
          link: null,
          isOwner: true,
          isMember: true,
          ownerName: '',
          searching: '',
          bibEntries: [],
          bibLoaded: false,
          // whether the document reads the linked .bib: GET /zotero/bib-load
          bibLoad: null,
          // the account's saved key: { username } once one is saved; the key itself never comes back
          saved: null,
          // picking a new library or collection for a linked project
          changing: false,
        };

        // build() makes fresh inputs; hand focus and the caret to the new copy
        // of whichever field the user was typing in.
        const rerender = () => {
          const active = document.activeElement;
          const testid = root.contains(active) ? active.dataset.testid : null;
          const caret = testid ? active.selectionStart : null;
          root.replaceChildren(build());
          const next = testid && root.querySelector(`[data-testid="${testid}"]`);
          if (!next) return;
          next.focus();
          if (caret != null) next.setSelectionRange(caret, caret);
        };

        const jfetch = async (url, init) => {
          // A JSON content type on a request without a body is a 400 from the server.
          const res = await aldine.fetch(url, init?.body ? { headers: { 'content-type': 'application/json' }, ...init } : init);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          return body;
        };

        /** The libraries the key reaches (`projectId`: the owner's link key when the account saved none). */
        const openPicker = async (current) => {
          const info = await jfetch('/api/zotero/validate', { method: 'POST', body: JSON.stringify({ projectId: aldine.project.id }) });
          state.userID = info.userID;
          state.username = info.username || `user ${info.userID}`;
          state.groups = info.groups || [];
          state.libraryPrefix = current?.libraryPrefix || `users/${info.userID}`;
          state.collectionKey = current?.collectionKey || '';
          await loadCollections();
          state.view = 'pick';
        };

        let readOnly = false;
        let firstLoad = true;
        const loadStatus = async () => {
          try {
            const p = await jfetch(`/api/projects/${aldine.project.id}`);
            state.link = p.zotero;
            // absent on a server without accounts, where everyone is the owner
            state.isOwner = p.isOwner !== false;
            state.isMember = p.isMember !== false;
            state.ownerName = p.ownerName || '';
            readOnly = !!p.readOnly;
            state.view = p.zotero ? 'linked' : state.isOwner ? 'connect' : 'ask-owner';
            state.changing = false;
            if (state.view === 'connect') {
              state.saved = await jfetch('/api/zotero/key').then((k) => (k.saved ? { username: k.username } : null), () => null);
              if (state.saved) await openPicker().catch(() => { state.view = 'connect'; });
            }
          } catch {
            state.view = 'connect';
          }
          busy = false;
          rerender();
          if (state.view === 'linked') checkBibLoad();
          if (firstLoad && state.view === 'linked') syncIfStale();
          firstLoad = false;
        };

        // Papers that cite from a group library get its new entries without
        // anyone pressing Sync: once an hour at most, when the project opens.
        // One automatic sync at a time: the one on open and a re-export can both be due.
        let autoSyncing = false;
        const syncIfStale = async () => {
          if (!state.isMember || readOnly || autoSyncing) return;
          autoSyncing = true;
          let res;
          try {
            res = await jfetch(`/api/projects/${aldine.project.id}/zotero/sync`, {
              method: 'POST',
              body: JSON.stringify({ branch: aldine.project.branch, olderThan: STALE_SECONDS }),
            });
          } catch {
            autoSyncing = false;
            return;
          }
          autoSyncing = false;
          if (!res.synced) { if (!res.fresh) await loadStatus(); return; }
          aldine.toast(`Synced ${res.itemCount ?? ''} references from Zotero into ${res.bibFile || 'zotero.bib'}`, 'info');
          await aldine.project.refreshFiles();
          await loadStatus();
        };

        const bibLoadUrl = () => `/api/projects/${aldine.project.id}/zotero/bib-load`;
        let bibLoadSeq = 0;
        const checkBibLoad = async () => {
          const seq = ++bibLoadSeq;
          let s;
          try {
            s = await jfetch(`${bibLoadUrl()}?branch=${encodeURIComponent(aldine.project.branch)}`);
          } catch {
            s = null;
          }
          if (seq !== bibLoadSeq) return;
          state.bibLoad = s;
          rerender();
          if (s && s.format && s.syncedFormat && s.format !== s.syncedFormat) reexport(s.format);
        };

        // The paper moved between BibTeX and biblatex: the fields its
        // bibliography reads differ, so the library is exported again.
        let reexported = null;
        const reexport = async (format) => {
          if (!state.isMember || readOnly || reexported === format || autoSyncing) return;
          reexported = format;
          autoSyncing = true;
          try {
            const res = await jfetch(`/api/projects/${aldine.project.id}/zotero/sync`, {
              method: 'POST',
              body: JSON.stringify({ branch: aldine.project.branch, force: false }),
            });
            autoSyncing = false;
            if (!res.synced) return;
            aldine.toast(`Exported ${res.itemCount ?? ''} references again with ${format === 'bibtex' ? 'BibTeX' : 'biblatex'} fields, which ${state.bibLoad?.rootFile || 'the paper'} uses`, 'info');
            await aldine.project.refreshFiles();
            await loadStatus();
          } catch { autoSyncing = false; /* the next sync tries again */ }
        };

        const fixLabel = (fix, done) => {
          const verb = done ? 'Added' : 'Add';
          return fix.kind === 'bibliography'
            ? `${verb} ${fix.entry} to \\bibliography in ${fix.file}`
            : `${verb} ${fix.command} to ${fix.file}`;
        };

        let adding = false;
        const addBibLine = async () => {
          adding = true;
          rerender();
          bibLoadSeq++;
          try {
            const res = await jfetch(bibLoadUrl(), { method: 'POST', body: JSON.stringify({ branch: aldine.project.branch }) });
            if (res.added) aldine.toast(fixLabel(res.added, true), 'ok');
            else if (res.loaded) aldine.toast(`${res.rootFile || 'The document'} already loads ${res.bibFile}`, 'ok');
            state.bibLoad = res;
          } catch (err) {
            aldine.toast(`Adding the line failed: ${err.message}`, 'error');
          }
          adding = false;
          rerender();
        };

        // The key is saved with the account and stays on the server: the
        // panel asks for libraries and collections by the account, not the key.
        const connect = async () => {
          const key = state.apiKey.trim();
          if (!key) { aldine.toast('Paste a Zotero API key first', 'error'); return; }
          setBusy(true);
          try {
            const info = await jfetch('/api/zotero/key', { method: 'PUT', body: JSON.stringify({ apiKey: key }) });
            state.apiKey = '';
            state.saved = { username: info.username };
            state.userID = info.userID;
            state.username = info.username || `user ${info.userID}`;
            state.groups = info.groups || [];
            state.libraryPrefix = state.changing && state.link ? state.link.libraryPrefix : `users/${info.userID}`;
            if (!state.changing) state.collectionKey = '';
            await loadCollections();
            state.view = 'pick';
          } catch (err) {
            aldine.toast(`Zotero: ${err.message}`, 'error');
          }
          setBusy(false);
          rerender();
        };

        const loadCollections = async () => {
          try {
            const list = await jfetch('/api/zotero/collections', {
              method: 'POST',
              body: JSON.stringify({ libraryPrefix: state.libraryPrefix, projectId: aldine.project.id }),
            });
            state.collections = list.map((c) => ({ ...c, path: c.path || c.name })).sort((a, b) => a.path.localeCompare(b.path));
          } catch {
            state.collections = [];
          }
        };

        const startChange = async () => {
          setBusy(true);
          state.changing = true;
          try {
            await openPicker(state.link);
          } catch (err) {
            // No key on the account and none the server will use: paste one.
            state.view = 'connect';
            if (!/key/i.test(err.message)) aldine.toast(`Zotero: ${err.message}`, 'error');
          }
          setBusy(false);
          rerender();
        };

        const link = async (collectionKey) => {
          setBusy(true);
          try {
            const res = await jfetch(`/api/projects/${aldine.project.id}/zotero/link`, {
              method: 'POST',
              body: JSON.stringify({
                libraryPrefix: state.libraryPrefix,
                collectionKey: collectionKey || undefined,
                branch: aldine.project.branch,
                // no bibFile: the server keeps the linked one, or defaults to
                // zotero.bib NEXT TO THE ROOT FILE, which is where
                // \addbibresource{zotero.bib} resolves
              }),
            });
            aldine.toast(`Imported ${res.itemCount ?? '?'} references into ${res.bibFile || 'zotero.bib'}`, 'ok');
            await aldine.project.refreshFiles();
            await aldine.project.refresh?.();
            await loadStatus();
          } catch (err) {
            aldine.toast(`Zotero link failed: ${err.message}`, 'error');
            setBusy(false);
          }
        };

        const sync = async () => {
          setBusy(true);
          try {
            const res = await jfetch(`/api/projects/${aldine.project.id}/zotero/sync`, {
              method: 'POST',
              body: JSON.stringify({ branch: aldine.project.branch, force: false }),
            });
            aldine.toast(res.unchanged ? 'Zotero library unchanged' : `Synced ${res.itemCount ?? ''} references`, 'ok');
            await aldine.project.refreshFiles();
            await loadStatus();
          } catch (err) {
            aldine.toast(`Sync failed: ${err.message}`, 'error');
            setBusy(false);
          }
        };

        const unlink = async () => {
          if (!window.confirm('Unlink Zotero from this project? The .bib file stays.')) return;
          try {
            await jfetch(`/api/projects/${aldine.project.id}/zotero`, { method: 'DELETE' });
          } catch (err) {
            aldine.toast(`Unlink failed: ${err.message}`, 'error');
            return;
          }
          await aldine.project.refresh?.();
          await loadStatus();
        };

        panel = {
          syncNow: () => { if (state.view === 'linked' && state.isMember && !busy) sync(); },
        };

        let bibSeq = 0;
        const loadBib = async () => {
          const seq = ++bibSeq;
          let entries;
          try {
            entries = await jfetch(`/api/projects/${aldine.project.id}/bib?branch=${encodeURIComponent(aldine.project.branch)}`);
          } catch {
            entries = [];
          }
          if (seq !== bibSeq) return;
          state.bibEntries = entries;
          state.bibLoaded = true;
          rerender();
        };
        // An import, a sync or any other change to the branch's files can add
        // entries: a list on screen reloads, a hidden one on its next focus.
        aldine.project.onFilesChanged?.(() => {
          if (state.bibLoaded && state.view === 'linked') loadBib();
          else state.bibLoaded = false;
          if (state.view === 'linked') checkBibLoad();
        });
        // The panel stays mounted while another tab shows: a line typed by
        // hand in the meantime is seen when it shows again.
        if (typeof IntersectionObserver === 'function') {
          new IntersectionObserver((seen) => {
            if (state.view === 'linked' && seen.some((e) => e.isIntersecting)) checkBibLoad();
          }).observe(root);
        }

        let busy = false;
        const setBusy = (b) => { busy = b; rerender(); };

        const section = (label) => h('div', { class: 'menu__label', style: { padding: '8px 2px 4px' } }, label);

        // Without the line that loads it, every citation from the .bib is undefined.
        function unloadedNote() {
          const load = state.bibLoad;
          if (!load || load.loaded) return null;
          return h('div', {
            dataset: { testid: 'zotero-bib-unloaded' },
            style: {
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px',
              margin: '10px 0 2px', padding: '8px 10px', borderRadius: 'var(--radius-m)',
              background: 'var(--warn-soft)', fontSize: '12px', lineHeight: '1.5',
            },
          },
            h('span', {}, `${load.rootFile || 'The document'} doesn’t load ${load.bibFile}, so its citations stay undefined.`),
            load.fix
              ? h('button', {
                class: 'btn btn--small btn--primary',
                style: { height: 'auto', minHeight: '28px', padding: '4px 10px', whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' },
                dataset: { testid: 'zotero-load-bib' },
                disabled: adding ? '' : null,
                onclick: addBibLine,
              }, adding ? 'Adding…' : fixLabel(load.fix))
              : h('span', { dataset: { testid: 'zotero-bib-hint' }, style: { color: 'var(--text-2)' } },
                `Add ${load.lines.biblatex} after \\usepackage{biblatex}, or ${load.lines.bibtex} after \\bibliographystyle{…} for BibTeX.`),
          );
        }

        function build() {
          const wrap = h('div', { class: 'panel-list', dataset: { testid: 'zotero-panel' }, style: { padding: '2px' } });

          if (state.view === 'loading') {
            wrap.append(h('div', { class: 'spinner', style: { margin: '20px auto' } }));
            return wrap;
          }

          if (state.view === 'ask-owner') {
            Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' });
            wrap.append(
              section('Zotero'),
              h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: '0' }, dataset: { testid: 'zotero-ask-owner' } },
                `Only ${state.ownerName ? `${state.ownerName}, the project owner,` : 'the project owner'} can link a Zotero library. Ask them to link one; its references then show here.`),
            );
            return wrap;
          }

          if (state.view === 'connect') {
            Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' });
            wrap.append(
              section('Connect Zotero'),
              h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: '0' } },
                'Paste a Zotero API key with library read access. ',
                h('a', { href: 'https://www.zotero.org/settings/keys/new', target: '_blank', style: { color: 'var(--accent)' } }, 'Create one'),
                '. Aldine keeps it for your other projects and never shows it again.'),
              h('input', {
                class: 'input',
                type: 'password',
                placeholder: 'Zotero API key',
                style: { width: '100%' },
                dataset: { testid: 'zotero-key' },
                value: state.apiKey,
                oninput: (e) => { state.apiKey = e.target.value; },
                onkeydown: (e) => { if (e.key === 'Enter') connect(); },
              }),
              h('button', {
                class: 'btn btn--primary',
                style: { width: '100%', justifyContent: 'center' },
                dataset: { testid: 'zotero-connect' },
                disabled: busy ? '' : null,
                onclick: connect,
              }, busy ? 'Checking…' : 'Connect'),
              state.changing || state.saved
                ? h('button', {
                  class: 'btn btn--ghost btn--small',
                  dataset: { testid: 'zotero-connect-back' },
                  onclick: () => { if (state.changing) { state.changing = false; state.view = 'linked'; rerender(); } else { setBusy(true); openPicker().catch(() => {}).then(() => setBusy(false)); } },
                }, state.changing ? 'Cancel' : `Keep using ${state.saved?.username || 'the saved key'}`)
                : null,
            );
            return wrap;
          }

          if (state.view === 'pick') {
            wrap.append(
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
                section(`Signed in as ${state.username}`),
                h('button', {
                  class: 'link-button',
                  style: { fontSize: '12px' },
                  dataset: { testid: 'zotero-other-key' },
                  onclick: () => { state.view = 'connect'; rerender(); },
                }, 'Use a different key'),
              ),
            );
            const libSelect = h('select', { class: 'input', style: { width: '100%' }, dataset: { testid: 'zotero-library' } },
              h('option', { value: `users/${state.userID}` }, 'My Library'),
              ...state.groups.map((g) => h('option', { value: `groups/${g.id}` }, `Group: ${g.name}`)),
            );
            libSelect.value = state.libraryPrefix;
            libSelect.addEventListener('change', async () => {
              state.libraryPrefix = libSelect.value;
              state.collectionKey = '';
              await loadCollections();
              rerender();
            });
            // Subcollections under their parents' names: two "Drafts" tell apart.
            const colSelect = h('select', { class: 'input', style: { width: '100%', marginTop: '6px' }, dataset: { testid: 'zotero-collection' } },
              h('option', { value: '' }, 'Entire library'),
              ...state.collections.map((c) => h('option', { value: c.key }, c.path)),
            );
            if (state.collections.some((c) => c.key === state.collectionKey)) colSelect.value = state.collectionKey;
            colSelect.addEventListener('change', () => { state.collectionKey = colSelect.value; });
            const target = state.changing && state.link ? state.link.bibFile : 'zotero.bib';
            wrap.append(
              libSelect,
              colSelect,
              h('button', {
                class: 'btn btn--primary',
                style: { marginTop: '8px', width: '100%', justifyContent: 'center' },
                dataset: { testid: 'zotero-import' },
                disabled: busy ? '' : null,
                onclick: () => link(colSelect.value),
              }, busy ? 'Importing…' : `Import into ${target}`),
              state.changing
                ? h('button', {
                  class: 'btn btn--ghost btn--small',
                  style: { marginTop: '6px', width: '100%', justifyContent: 'center' },
                  dataset: { testid: 'zotero-change-cancel' },
                  onclick: () => { state.changing = false; state.view = 'linked'; rerender(); },
                }, 'Cancel')
                : null,
            );
            return wrap;
          }

          // linked
          const z = state.link;
          const [kind, libId] = String(z.libraryPrefix).split('/');
          const library = kind === 'groups'
            ? `Group: ${z.libraryName || libId}`
            : `${z.username || `Zotero user ${libId}`}’s library`;
          const collection = z.collectionKey ? ` › ${z.collectionName || `collection ${z.collectionKey}`}` : '';
          const actions = [
            state.isMember ? h('button', { class: 'btn btn--small', dataset: { testid: 'zotero-sync' }, disabled: busy ? '' : null, onclick: sync }, busy ? 'Syncing…' : 'Sync now') : null,
            state.isOwner ? h('button', { class: 'btn btn--small btn--ghost', dataset: { testid: 'zotero-change' }, disabled: busy ? '' : null, onclick: startChange }, 'Change library or collection') : null,
            state.isOwner ? h('button', { class: 'btn btn--small btn--ghost', dataset: { testid: 'zotero-unlink' }, onclick: unlink }, 'Unlink') : null,
          ].filter(Boolean);
          wrap.append(
            section('Linked library'),
            h('div', { style: { fontSize: '12px', color: 'var(--text-2)', padding: '0 2px 6px' }, dataset: { testid: 'zotero-linked' } },
              `${library}${collection} → ${z.bibFile}`,
              z.lastSyncedAt ? h('div', {}, `Last synced ${new Date(z.lastSyncedAt).toLocaleString()}`) : null,
            ),
            ...(actions.length ? [h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, ...actions)] : []),
            ...[unloadedNote()].filter(Boolean),
            section('Insert citation'),
            h('input', {
              class: 'input',
              placeholder: 'Search key, author, title…',
              style: { width: '100%' },
              dataset: { testid: 'zotero-search' },
              value: state.searching,
              oninput: (e) => { state.searching = e.target.value; rerender(); },
              onfocus: () => { if (!state.bibLoaded) loadBib(); },
            }),
          );

          const q = state.searching.trim().toLowerCase();
          const matches = state.bibEntries
            .filter((e) => !q || e.key.toLowerCase().includes(q) || (e.author || '').toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q))
            .slice(0, 30);
          const list = h('div', { style: { marginTop: '6px' } });
          for (const e of matches) {
            list.append(h('button', {
              class: 'tree__item',
              style: { height: 'auto', padding: '5px 8px', display: 'block' },
              dataset: { testid: `cite-${e.key}` },
              title: `Insert \\cite{${e.key}}`,
              onclick: () => citeToast(aldine, e.key, aldine.editor.insertCitation ? aldine.editor.insertCitation(e.key) : (aldine.editor.insertAtCursor(`\\cite{${e.key}}`), 'inserted')),
            },
              h('div', { style: { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.key),
              h('div', { style: { color: 'var(--text-2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' } },
                [e.author, e.year].filter(Boolean).join(' · ') || e.title || ''),
            ));
          }
          if (state.bibEntries.length && !matches.length) list.append(h('p', { style: { color: 'var(--text-2)', fontSize: '12px', padding: '4px' } }, 'No matches.'));
          wrap.append(list);
          return wrap;
        }

        rerender();
        loadStatus();
      },
    });
  },
};
