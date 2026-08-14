/**
 * Aldine Zotero plugin — vanilla-DOM sidebar panel.
 * Link a Zotero library (API key), pick a library/collection, keep a .bib
 * in sync, and insert \cite{...} while writing.
 */

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
          searching: '',
          bibEntries: [],
        };

        const rerender = () => {
          root.replaceChildren(build());
        };

        const jfetch = async (url, init) => {
          const res = await aldine.fetch(url, init ? { headers: { 'content-type': 'application/json' }, ...init } : undefined);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          return body;
        };

        const loadStatus = async () => {
          try {
            const p = await jfetch(`/api/projects/${aldine.project.id}`);
            state.link = p.zotero;
            state.view = p.zotero ? 'linked' : 'connect';
          } catch {
            state.view = 'connect';
          }
          busy = false;
          rerender();
        };

        const connect = async () => {
          const key = state.apiKey.trim();
          if (!key) { aldine.toast('Paste a Zotero API key first', 'error'); return; }
          setBusy(true);
          try {
            const info = await jfetch('/api/zotero/validate', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
            state.userID = info.userID;
            state.username = info.username || `user ${info.userID}`;
            state.groups = info.groups || [];
            state.libraryPrefix = `users/${info.userID}`;
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
            state.collections = await jfetch('/api/zotero/collections', {
              method: 'POST',
              body: JSON.stringify({ apiKey: state.apiKey.trim(), libraryPrefix: state.libraryPrefix }),
            });
          } catch {
            state.collections = [];
          }
        };

        const link = async (collectionKey) => {
          setBusy(true);
          try {
            const res = await jfetch(`/api/projects/${aldine.project.id}/zotero/link`, {
              method: 'POST',
              body: JSON.stringify({
                apiKey: state.apiKey.trim(),
                libraryPrefix: state.libraryPrefix,
                collectionKey: collectionKey || undefined,
                // no bibFile: the server defaults to zotero.bib NEXT TO THE ROOT
                // FILE, which is where \addbibresource{zotero.bib} resolves
              }),
            });
            aldine.toast(`Imported ${res.itemCount ?? '?'} references into ${res.bibFile || 'zotero.bib'}`, 'ok');
            await aldine.project.refreshFiles();
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
          await jfetch(`/api/projects/${aldine.project.id}/zotero`, { method: 'DELETE' });
          await loadStatus();
        };

        const loadBib = async () => {
          try {
            state.bibEntries = await jfetch(`/api/projects/${aldine.project.id}/bib?branch=${encodeURIComponent(aldine.project.branch)}`);
          } catch {
            state.bibEntries = [];
          }
          rerender();
        };

        let busy = false;
        const setBusy = (b) => { busy = b; rerender(); };

        const section = (label) => h('div', { class: 'menu__label', style: { padding: '8px 2px 4px' } }, label);

        function build() {
          const wrap = h('div', { class: 'panel-list', dataset: { testid: 'zotero-panel' }, style: { padding: '2px' } });

          if (state.view === 'loading') {
            wrap.append(h('div', { class: 'spinner', style: { margin: '20px auto' } }));
            return wrap;
          }

          if (state.view === 'connect') {
            Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' });
            wrap.append(
              section('Connect Zotero'),
              h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: '0' } },
                'Paste a Zotero API key with library read access. ',
                h('a', { href: 'https://www.zotero.org/settings/keys/new', target: '_blank', style: { color: 'var(--accent)' } }, 'Create one'),
                '.'),
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
            );
            return wrap;
          }

          if (state.view === 'pick') {
            wrap.append(section(`Signed in as ${state.username}`));
            const libSelect = h('select', { class: 'input', style: { width: '100%' }, dataset: { testid: 'zotero-library' } },
              h('option', { value: `users/${state.userID}` }, 'My Library'),
              ...state.groups.map((g) => h('option', { value: `groups/${g.id}` }, `Group: ${g.name}`)),
            );
            libSelect.value = state.libraryPrefix;
            libSelect.addEventListener('change', async () => {
              state.libraryPrefix = libSelect.value;
              await loadCollections();
              rerender();
            });
            const colSelect = h('select', { class: 'input', style: { width: '100%', marginTop: '6px' }, dataset: { testid: 'zotero-collection' } },
              h('option', { value: '' }, 'Entire library'),
              ...state.collections.map((c) => h('option', { value: c.key }, c.name)),
            );
            wrap.append(
              libSelect,
              colSelect,
              h('button', {
                class: 'btn btn--primary',
                style: { marginTop: '8px', width: '100%', justifyContent: 'center' },
                dataset: { testid: 'zotero-import' },
                disabled: busy ? '' : null,
                onclick: () => link(colSelect.value),
              }, busy ? 'Importing…' : 'Import into zotero.bib'),
            );
            return wrap;
          }

          // linked
          const z = state.link;
          wrap.append(
            section('Linked library'),
            h('div', { style: { fontSize: '12px', color: 'var(--text-2)', padding: '0 2px 6px' } },
              `${z.libraryPrefix}${z.collectionKey ? ' · collection' : ''} → ${z.bibFile}`,
              z.lastSyncedAt ? h('div', {}, `Last synced ${new Date(z.lastSyncedAt).toLocaleString()}`) : null,
            ),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn btn--small', dataset: { testid: 'zotero-sync' }, disabled: busy ? '' : null, onclick: sync }, busy ? 'Syncing…' : 'Sync now'),
              h('button', { class: 'btn btn--small btn--ghost', onclick: unlink }, 'Unlink'),
            ),
            section('Insert citation'),
            h('input', {
              class: 'input',
              placeholder: 'Search key, author, title…',
              style: { width: '100%' },
              dataset: { testid: 'zotero-search' },
              value: state.searching,
              oninput: (e) => { state.searching = e.target.value; rerender(); },
              onfocus: () => { if (!state.bibEntries.length) loadBib(); },
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
              onclick: () => { aldine.editor.insertAtCursor(`\\cite{${e.key}}`); aldine.toast(`Inserted \\cite{${e.key}}`, 'ok'); },
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
