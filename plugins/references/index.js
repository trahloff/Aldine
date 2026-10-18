/** Add-a-reference-by-DOI/arXiv plugin. Proves a second plugin extends Aldine. */

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

export default {
  activate(aldine) {
    aldine.ui.registerSidebarPanel({
      id: 'references',
      title: 'Cite',
      render(root) {
        let busy = false;
        let query = '';
        let searchTerm = '';
        let results = [];
        let searching = false;
        let searchSeq = 0;

        const addQuery = async (q, label) => {
          if (!q || busy) return;
          busy = true; draw();
          try {
            const res = await aldine.fetch(`/api/projects/${aldine.project.id}/references/add`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: q, branch: aldine.project.branch }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            await aldine.project.refreshFiles();
            loadBib();
            if (body.key) {
              aldine.editor.insertAtCursor(`\\cite{${body.key}}`);
              aldine.toast(body.duplicate ? `Already in bibliography — inserted \\cite{${body.key}}` : `Added ${body.key} and inserted citation`, 'ok');
            }
          } catch (err) {
            aldine.toast(`${label || 'Lookup'} failed: ${err.message}`, 'error');
          }
          busy = false; draw();
        };

        const add = () => { const q = query.trim(); if (q) { query = ''; addQuery(q, 'Lookup'); } };

        let searchTimer = null;
        const runSearch = () => {
          const q = searchTerm.trim();
          if (q.length < 3) { results = []; searching = false; draw(); return; }
          const seq = ++searchSeq;
          searching = true; draw();
          aldine.fetch(`/api/references/search?q=${encodeURIComponent(q)}`)
            .then((r) => r.json())
            .then((body) => {
              if (seq !== searchSeq) return;
              results = Array.isArray(body) ? body : [];
              searching = false; draw();
            })
            .catch(() => { if (seq === searchSeq) { searching = false; draw(); } });
        };
        const onSearchInput = (v) => {
          searchTerm = v;
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(runSearch, 350);
        };

        const cite = (hit) => addQuery(hit.doi || `openalex:${hit.id}`, 'Add');

        // The project's own bibliography: every entry of every .bib file.
        let bib = [];
        let bibLoaded = false;
        let filter = '';
        const loadBib = async () => {
          try {
            const res = await aldine.fetch(`/api/projects/${aldine.project.id}/bib?branch=${encodeURIComponent(aldine.project.branch)}`);
            const entries = res.ok ? await res.json() : [];
            // one row per key: LaTeX resolves a key once, whichever file holds it
            bib = [...new Map(entries.map((e) => [e.key, e])).values()];
          } catch { bib = []; }
          bibLoaded = true;
          drawBib();
        };
        const insertKey = (key) => {
          aldine.editor.insertAtCursor(`\\cite{${key}}`);
          aldine.toast(`Inserted \\cite{${key}}`, 'ok');
        };

        const line1 = { fontWeight: '600', fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
        const line2 = { color: 'var(--text-2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
        const label = (text, top) => h('div', { class: 'menu__label', style: { padding: `${top ? 10 : 0}px 2px 0` } }, text);

        // Inputs are built once and kept: redrawing only the lists keeps focus
        // and the caret in the field the user is typing in.
        const bibFilter = h('input', {
          class: 'input',
          placeholder: 'Filter by key, author, title…',
          style: { width: '100%' },
          dataset: { testid: 'cite-bib-filter' },
          oninput: (e) => { filter = e.target.value; drawBib(); },
        });
        const bibList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' }, dataset: { testid: 'cite-bib-list' } });
        const searchInput = h('input', {
          class: 'input',
          placeholder: 'Title, author, keywords…',
          style: { width: '100%' },
          dataset: { testid: 'reference-search' },
          oninput: (e) => onSearchInput(e.target.value),
        });
        const hits = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
        const queryInput = h('input', {
          class: 'input',
          placeholder: '10.1145/… · arXiv:2401.01234',
          style: { width: '100%' },
          dataset: { testid: 'reference-query' },
          oninput: (e) => { query = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') add(); },
        });
        const addButton = h('button', {
          class: 'btn btn--primary',
          style: { width: '100%', justifyContent: 'center' },
          dataset: { testid: 'reference-add' },
          onclick: add,
        });

        function drawBib() {
          const q = filter.trim().toLowerCase();
          const matches = bib.filter((e) => !q || [e.key, e.author, e.title, e.year].some((v) => String(v || '').toLowerCase().includes(q)));
          const rows = matches.slice(0, 50).map((e) => h('button', {
            class: 'tree__item',
            style: { height: 'auto', padding: '5px 8px', display: 'block' },
            dataset: { testid: `cite-bib-${e.key}` },
            title: `Insert \\cite{${e.key}}`,
            onclick: () => insertKey(e.key),
          },
            h('div', { style: line1 }, e.title || e.key),
            h('div', { style: line2 }, [e.key, e.author, e.year].filter(Boolean).join(' · ')),
          ));
          if (!bibLoaded) rows.push(h('div', { class: 'spinner', style: { margin: '6px auto' } }));
          else if (!bib.length) rows.push(h('p', { style: { color: 'var(--text-2)', fontSize: '12px', padding: '2px 4px', margin: 0 } }, 'No entries in this project’s .bib files yet. Search below to add one.'));
          else if (!matches.length) rows.push(h('p', { style: { color: 'var(--text-2)', fontSize: '12px', padding: '2px 4px', margin: 0 } }, 'No matches.'));
          else if (matches.length > 50) rows.push(h('p', { style: { color: 'var(--text-2)', fontSize: '11px', padding: '2px 4px', margin: 0 } }, `${matches.length - 50} more; narrow the filter.`));
          bibFilter.style.display = bib.length > 8 ? '' : 'none';
          bibList.replaceChildren(...rows);
        }

        function draw() {
          hits.replaceChildren(...(searching ? [h('div', { class: 'spinner', style: { margin: '6px auto' } })] : []),
            ...results.slice(0, 12).map((hit) => h('button', {
              class: 'tree__item',
              style: { height: 'auto', padding: '6px 8px', display: 'block' },
              dataset: { testid: `search-hit-${hit.id}` },
              title: `Insert \\cite for “${hit.title}”`,
              onclick: () => cite(hit),
            },
              h('div', { style: line1 }, hit.title),
              h('div', { style: line2 }, [hit.authors, hit.year, hit.venue].filter(Boolean).join(' · ')),
            )));
          queryInput.value = query;
          addButton.disabled = busy;
          addButton.textContent = busy ? 'Fetching…' : 'Add & cite';
        }

        root.replaceChildren(h('div', { class: 'panel-list', dataset: { testid: 'references-panel' }, style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' } },
          label('In this project'), bibFilter, bibList,
          label('Search papers', true), searchInput, hits,
          label('Or add by identifier', true), queryInput, addButton,
        ));
        draw();
        drawBib();
        loadBib();
      },
    });
  },
};
