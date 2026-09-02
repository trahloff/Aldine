import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, typeAtEnd, cleanup } from './helpers';

/** Must match ALDINE_MCP_TOKEN in playwright.config.ts (auth is off in this
 *  suite, so /mcp runs in static-token mode). Overridable for compose runs. */
const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || 'http://localhost:3100';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Stable opening line.',
  '',
  'Results improve steadily across trials.',
  '\\end{document}',
  '',
].join('\n');

async function connect(token = MCP_TOKEN): Promise<Client> {
  const client = new Client({ name: 'aldine-e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  ));
  return client;
}

/** Tool results carry one JSON text block; guard failures are prose + isError. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
}

test.describe('MCP connector (static-token mode)', () => {
  test('full agent loop: list → structure → read → edit (stale retry) → batch_write → compile', async ({ request }) => {
    test.setTimeout(300_000); // two real latexmk runs on top of the tool loop
    const id = await createProject(request, 'MCP Loop');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });

      // ---- list_projects ----
      const list = await call(client, 'list_projects', {});
      expect(list.isError).toBeFalsy();
      const mine = (list.body as Array<any>).find((p) => p.id === id);
      expect(mine).toBeTruthy();
      expect(mine.name).toBe('MCP Loop');
      expect(mine.branches).toContain('main');
      expect(typeof mine.rootFile).toBe('string');
      expect(typeof mine.engine).toBe('string');

      // ---- project_structure ----
      const struct = await call(client, 'project_structure', { project: id });
      expect(struct.isError).toBeFalsy();
      expect(struct.body.files.map((f: any) => f.path)).toContain('main.tex');
      expect(typeof struct.body.contentVersion).toBe('number');
      expect(struct.body.branch).toBe('main');
      expect(typeof struct.body.head).toBe('string');

      // ---- read_file ----
      const read = await call(client, 'read_file', { project: id, path: 'main.tex' });
      expect(read.isError).toBeFalsy();
      expect(read.body.content).toBe(MAIN);
      expect(read.body.totalLines).toBe(MAIN.split('\n').length);
      expect(typeof read.body.contentVersion).toBe('number');

      // ---- edit_file, stale-anchor retry etiquette ----
      // the file drifts after the read: the anchored line is reworded
      const drifted = MAIN.replace('improve steadily across', 'improve dramatically across');
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: drifted } });

      const stale = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
      });
      expect(stale.isError).toBeFalsy();
      expect(stale.body.error).toBe('stale_anchor');
      expect(stale.body.edit_index).toBe(0);
      expect(Array.isArray(stale.body.candidates)).toBeTruthy();
      expect(stale.body.candidates.length).toBeGreaterThanOrEqual(1);
      expect(stale.body.candidates.length).toBeLessThanOrEqual(3);
      expect(stale.body.candidates.some((c: any) => typeof c.line === 'number' && c.text.includes('dramatically'))).toBeTruthy();
      expect(typeof stale.body.contentVersion).toBe('number');
      // nothing was applied
      expect(await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text()).toBe(drifted);

      // retry: re-read, re-anchor on the current text, apply
      const reread = await call(client, 'read_file', { project: id, path: 'main.tex' });
      expect(reread.body.content).toContain('Results improve dramatically across trials.');
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve dramatically across trials.', replacement: 'Results improve markedly across trials.' }],
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.applied).toBe(1);
      expect(edit.body.snippet).toContain('markedly');
      expect(typeof edit.body.contentVersion).toBe('number');
      expect(edit.body.branch).toBe('main');
      const onDisk = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(onDisk).toContain('Results improve markedly across trials.');
      expect(onDisk).not.toContain('dramatically');

      // ---- commit: lands the edit now so the batch_write window is clean ----
      const committed = await call(client, 'commit', { project: id, message: 'Reword the results line' });
      expect(committed.isError).toBeFalsy();
      expect(committed.body.committed).toBe(true);
      expect(committed.body.hash).toMatch(/^[0-9a-f]{7,}$/);

      // ---- batch_write: multi-file change, exactly ONE commit with the message ----
      const logBefore = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      const batch = await call(client, 'batch_write', {
        project: id,
        files: [
          { path: 'discussion.tex', content: 'The discussion section, added by the agent.\n' },
          { path: 'main.tex', edits: [{ quote: '\\end{document}', replacement: '\\input{discussion}\n\\end{document}' }] },
        ],
        message: 'Add discussion section',
      });
      expect(batch.isError).toBeFalsy();
      expect(batch.body.ok).toBe(true);
      expect(batch.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      const logAfter = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      expect(logAfter.length).toBe(logBefore.length + 1);
      expect(logAfter[0].message).toBe('Add discussion section');
      expect(logAfter[0].author).toBe('Claude');
      const withInput = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(withInput).toContain('\\input{discussion}');

      // ---- compile: valid document ----
      const okCompile = await call(client, 'compile', { project: id });
      expect(okCompile.isError).toBeFalsy();
      expect(okCompile.body.ok).toBe(true);
      expect(okCompile.body.pdfUrl).toContain(`/api/projects/${id}/output`);
      expect(okCompile.body.deepLink).toContain(`/p/${id}`);
      expect(typeof okCompile.body.durationMs).toBe('number');
      expect(okCompile.body.timedOut).toBe(false);
      // the raw log never crosses the wire — only a byte-capped tail
      expect(okCompile.body.log).toBeUndefined();
      expect(Buffer.byteLength(okCompile.body.logTail, 'utf8')).toBeLessThanOrEqual(4096);

      // ---- compile: broken document returns parsed errors ----
      const broken = withInput.replace('Stable opening line.', 'Stable opening line.\n\\thisisnotacommand');
      const write = await call(client, 'write_file', { project: id, path: 'main.tex', content: broken });
      expect(write.isError).toBeFalsy();
      expect(write.body.ok).toBe(true);
      const badCompile = await call(client, 'compile', { project: id });
      expect(badCompile.isError).toBeFalsy();
      expect(badCompile.body.ok).toBe(false);
      expect(badCompile.body.errors.length).toBeGreaterThanOrEqual(1);
      const err = badCompile.body.errors.find((e: any) => e.type === 'error');
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/undefined control sequence|thisisnotacommand/i);
      expect(typeof err.line).toBe('number');
      expect(badCompile.body.log).toBeUndefined();
      expect(Buffer.byteLength(badCompile.body.logTail, 'utf8')).toBeLessThanOrEqual(4096);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('edit_file against a live collab session merges with typing instead of clobbering', async ({ page, request }) => {
    const id = await createProject(request, 'MCP Live Merge');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });

      await openProject(page, id);
      await typeAtEnd(page, 'TYPED-DURING-AGENT-EDIT');
      // settle over the websocket but stay inside the 1.5 s store debounce, so
      // at edit time the keystrokes exist only in the live document
      await page.waitForTimeout(500);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Edited opening line.' }],
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.applied).toBe(1);

      // both survive in the live editor: the human's keystrokes and the agent's edit
      await expect(page.locator('.cm-content')).toContainText('TYPED-DURING-AGENT-EDIT');
      await expect(page.locator('.cm-content')).toContainText('Edited opening line.');
      // and both reach disk (edit_file flushes/schedules through the open doc)
      const flushed = await call(client, 'read_file', { project: id, path: 'main.tex' });
      expect(flushed.body.content).toContain('TYPED-DURING-AGENT-EDIT');
      expect(flushed.body.content).toContain('Edited opening line.');
      expect(flushed.body.content).not.toContain('Stable opening line.');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('reference tools: list_citations, list_labels, wordcount over an \\input graph, references_add (mock upstream)', async ({ request }) => {
    const id = await createProject(request, 'MCP References');
    const client = await connect();
    try {
      const put = (path: string, content: string) =>
        request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
      // the include graph: main → sections/methods → sections/data; notes.tex
      // is only reachable through a commented-out \input, so it is a label
      // source but not part of the document
      await put('main.tex', [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}\\label{sec:intro}',
        'One two three four five.',
        '\\input{sections/methods}',
        '% \\input{notes}',
        '\\begin{equation}\\label{eq:main}',
        'E = mc^2',
        '\\end{equation}',
        'See \\ref{sec:methods} and \\cite{knuth1984}.',
        '\\bibliographystyle{plain}',
        '\\bibliography{references,chapters/more}',
        '\\end{document}',
        '',
      ].join('\n'));
      await put('sections/methods.tex', '\\section{Methods}\\label{sec:methods}\nSix seven eight.\n\\input{sections/data}\n');
      await put('sections/data.tex', 'Alpha beta gamma delta epsilon zeta.\n');
      await put('notes.tex', '\\section{Notes}\\label{sec:notes}\nScratch words that never compile into the paper.\n');
      await put('references.bib', [
        '@article{knuth1984,',
        '  author  = {Knuth, Donald E.},',
        '  title   = {Literate Programming},',
        '  journal = {The Computer Journal},',
        '  year    = {1984},',
        '}',
        '@book{lamport1994,',
        '  author    = {Lamport, Leslie},',
        '  title     = {LaTeX: A Document Preparation System},',
        '  publisher = {Addison-Wesley},',
        '  year      = {1994},',
        '}',
        '',
      ].join('\n'));
      await put('chapters/more.bib', '@misc{seeded2001,\n  author = {Seed, Sam},\n  title = {A Seeded Entry},\n  year = {2001},\n}\n');

      // ---- list_citations: every .bib on the branch, attributed to its file ----
      const cites = await call(client, 'list_citations', { project: id });
      expect(cites.isError).toBeFalsy();
      expect(cites.body.branch).toBe('main');
      expect(typeof cites.body.head).toBe('string');
      const byKey = Object.fromEntries(cites.body.citations.map((c: any) => [c.key, c]));
      expect(Object.keys(byKey).sort()).toEqual(['knuth1984', 'lamport1994', 'seeded2001']);
      expect(byKey.knuth1984).toEqual({ key: 'knuth1984', title: 'Literate Programming', author: 'Knuth, Donald E.', year: '1984', file: 'references.bib' });
      expect(byKey.lamport1994.file).toBe('references.bib');
      expect(byKey.seeded2001).toMatchObject({ file: 'chapters/more.bib', year: '2001' });
      for (const c of cites.body.citations) expect(Object.keys(c).sort()).toEqual(['author', 'file', 'key', 'title', 'year']);

      // ---- list_labels: every .tex on the branch, including the orphan ----
      const labels = await call(client, 'list_labels', { project: id });
      expect(labels.isError).toBeFalsy();
      expect(labels.body.branch).toBe('main');
      const labelPairs = labels.body.labels.map((l: any) => `${l.label}@${l.file}`).sort();
      expect(labelPairs).toEqual([
        'eq:main@main.tex',
        'sec:intro@main.tex',
        'sec:methods@sections/methods.tex',
        'sec:notes@notes.tex',
      ]);

      // ---- wordcount: the compiled document only — the graph, not the tree ----
      const wc = await call(client, 'wordcount', { project: id });
      expect(wc.isError).toBeFalsy();
      expect(wc.body.rootFile).toBe('main.tex');
      expect(Object.keys(wc.body.files).sort()).toEqual(['main.tex', 'sections/data.tex', 'sections/methods.tex']);
      expect(wc.body.files['sections/data.tex']).toBe(6);
      expect(wc.body.files['sections/methods.tex']).toBeGreaterThanOrEqual(3);
      expect(wc.body.files['main.tex']).toBeGreaterThanOrEqual(5);
      expect(wc.body.total).toBe(Object.values(wc.body.files as Record<string, number>).reduce((a, b) => a + b, 0));

      // ---- references_add: the DOI resolves against the mock upstream on :4919
      //      (DOI_API_BASE in playwright.config.ts), never the real doi.org ----
      const added = await call(client, 'references_add', { project: id, query: '10.1145/mock.12345' });
      expect(added.isError).toBeFalsy();
      expect(added.body).toMatchObject({ key: 'doe2020', bibFile: 'references.bib', duplicate: false, branch: 'main' });
      expect(typeof added.body.contentVersion).toBe('number');
      expect(typeof added.body.head).toBe('string');
      const bib = await (await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`)).text();
      expect(bib).toContain('@article{knuth1984');
      expect(bib).toContain('@book{lamport1994');
      expect(bib).toContain('@article{doe2020');
      // the upstream &amp; is decoded and LaTeX-escaped — a bare & would break the compile
      expect(bib).toContain('Knowledge Discovery \\& Data Mining');
      expect(bib).not.toContain('&amp;');
      expect(bib).not.toMatch(/(?<!\\)&/);

      // the index sees the new key immediately (flushed, version-keyed cache)
      const cites2 = await call(client, 'list_citations', { project: id });
      const doe = cites2.body.citations.find((c: any) => c.key === 'doe2020');
      expect(doe).toMatchObject({ file: 'references.bib', year: '2020', author: 'Doe, Jane' });
      expect(doe.title).toMatch(/Knowledge Discovery/);

      // a known key is reported, not appended twice — the file is byte-identical
      const dup = await call(client, 'references_add', { project: id, query: 'https://doi.org/10.1145/mock.12345' });
      expect(dup.isError).toBeFalsy();
      expect(dup.body).toMatchObject({ key: 'doe2020', duplicate: true });
      expect(await (await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`)).text()).toBe(bib);

      // a title is not a lookup: refused with prose the model can relay
      const title = await call(client, 'references_add', { project: id, query: 'Attention is all you need' });
      expect(title.isError).toBeTruthy();
      expect(title.text).toMatch(/No reference found/);

      // an explicit bibFile targets that file and lands beside the seeded entry
      const other = await call(client, 'references_add', { project: id, query: '10.1145/mock.67890', bibFile: 'chapters/more.bib' });
      expect(other.isError).toBeFalsy();
      expect(other.body.bibFile).toBe('chapters/more.bib');
      const more = await (await request.get(`/api/projects/${id}/file?branch=main&path=chapters/more.bib`)).text();
      expect(more).toContain('@misc{seeded2001');
      expect(more).toContain(`@article{${other.body.key}`);

      // the reference lands as its own attributed commit, not swept under the human
      const committed = await call(client, 'commit', { project: id, message: 'Land references' });
      expect(committed.isError).toBeFalsy();
      const log = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      const refCommit = log.find((c: any) => c.message === 'Add reference doe2020');
      expect(refCommit).toBeTruthy();
      expect(refCommit.author).toBe('Claude');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('auth negatives: no credential and wrong token both get 401', async ({ request }) => {
    const rpc = { jsonrpc: '2.0', method: 'ping', id: 1 };
    const bare = await request.post('/mcp', { data: rpc });
    expect(bare.status()).toBe(401);
    const wrong = await request.post('/mcp', { data: rpc, headers: { authorization: 'Bearer not-the-operator-token' } });
    expect(wrong.status()).toBe(401);
  });
});
