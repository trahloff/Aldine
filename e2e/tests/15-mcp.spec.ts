import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, typeAtEnd, cleanup } from './helpers';

/** Must match ALDINE_MCP_TOKEN in playwright.config.ts (auth is off in this
 *  suite, so /mcp runs in static-token mode). Overridable for compose runs. */
const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || `http://localhost:${process.env.E2E_PORT || 3100}`;

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

      // the edit committed as it landed; commit finds nothing waiting and says so
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      const committed = await call(client, 'commit', { project: id, message: 'Reword the results line' });
      expect(committed.isError).toBeFalsy();
      expect(committed.body.committed).toBe(false);
      expect(committed.body.recentClaudeCommits[0].message).toBe('Edit main.tex');

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
      // The link is signed, absolute, and opens with no session —
      // the MCP App viewer fetches it from a cookieless sandbox.
      expect(okCompile.body.pdfUrl).toMatch(/^https?:\/\/.+[?&]sig=/);
      expect(okCompile.body.pdfStale).toBe(false);
      expect(okCompile.body.pages).toBeGreaterThan(0);
      expect(okCompile.body.pdfFile).toBe('main.pdf');
      expect(Date.parse(okCompile.body.typesetAt)).toBeGreaterThan(0);
      const anon = await fetch(okCompile.body.pdfUrl);
      expect(anon.status).toBe(200);
      expect(anon.headers.get('content-type')).toContain('application/pdf');
      expect(anon.headers.get('access-control-allow-origin')).toBe('*');
      const again = await call(client, 'get_pdf_url', { project: id });
      expect(again.isError).toBeFalsy();
      expect(again.body.pages).toBe(okCompile.body.pages);
      expect((await fetch(again.body.pdfUrl)).status).toBe(200);
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
      // errorsTotal counts type:"error" rows only; warnings have their own total
      expect(badCompile.body.errorsTotal).toBe(badCompile.body.errors.filter((e: any) => e.type === 'error').length);
      expect(badCompile.body.warningsTotal).toBe(badCompile.body.errors.filter((e: any) => e.type === 'warning').length);
      const err = badCompile.body.errors.find((e: any) => e.type === 'error');
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/undefined control sequence|thisisnotacommand/i);
      expect(typeof err.line).toBe('number');
      // the row names the token and carries the source line TeX was reading
      expect(err.message).toContain('\\thisisnotacommand');
      expect(err.context).toContain('\\thisisnotacommand');
      // the log window is anchored on the first error, not the end of the log
      expect(badCompile.body.logTail).toMatch(/thisisnotacommand/);
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

  test('a person\'s typing before and between agent edits stays out of the Claude commits and is never swept into them', async ({ page, request }) => {
    const id = await createProject(request, 'MCP Autosave Race');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });

      await openProject(page, id);
      await typeAtEnd(page, 'HUMAN-TYPED-LINE ');
      // past the 1.5 s store debounce (the typing is on disk, uncommitted)
      // and well inside the 20 s autosave, so the pending autosave is what
      // the agent edit has to keep out of its own commit
      await page.waitForTimeout(2000);

      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
      });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.applied).toBe(1);
      // the commit is made before the tool answers, not by a later debounce
      expect(edit.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      const patchOf = async (hash: string): Promise<string> => (await (await request.get(`/api/projects/${id}/commit/${hash}/diff`)).json()).patch;
      let log: Array<{ hash: string; author: string; message: string }> = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      expect(log[0].author).toBe('Claude');
      expect(log[0].message).toBe('Edit main.tex');

      // typing BETWEEN two agent edits: the window that used to end up in the
      // second edit's Claude commit (and be undone by "Revert these changes")
      await typeAtEnd(page, 'TYPED-BETWEEN-EDITS ');
      await page.waitForTimeout(2000);
      const second = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Edited opening line.' }],
        message: 'Edit the opening line',
      });
      expect(second.isError).toBeFalsy();
      expect(second.body.commit).toMatch(/^[0-9a-f]{7,}$/);

      log = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      const claude = log.filter((c) => c.author === 'Claude');
      expect(claude.map((c) => c.message)).toEqual(['Edit the opening line', 'Edit main.tex']);
      const claudePatches = await Promise.all(claude.map((c) => patchOf(c.hash)));
      expect(claudePatches[1]).toMatch(/^\+.*markedly/m);
      expect(claudePatches[0]).toMatch(/^\+.*Edited opening line/m);
      // added lines only: the typed lines may appear as unchanged hunk context
      for (const p of claudePatches) {
        expect(p).not.toMatch(/^\+.*HUMAN-TYPED-LINE/m);
        expect(p).not.toMatch(/^\+.*TYPED-BETWEEN-EDITS/m);
      }

      // both typed lines reached history as anonymous autosaves, before the edit that followed them
      const autosaves = log.filter((c) => c.message === 'aldine: autosave');
      const autosavePatches = await Promise.all(autosaves.map((c) => patchOf(c.hash)));
      expect(autosavePatches.some((p) => /^\+.*HUMAN-TYPED-LINE/m.test(p))).toBe(true);
      expect(autosavePatches.some((p) => /^\+.*TYPED-BETWEEN-EDITS/m.test(p))).toBe(true);
      expect(log.findIndex((c) => c.message === 'Edit the opening line')).toBeLessThan(log.findIndex((c) => c.message === 'aldine: autosave'));
      // and the editor still shows everything
      await expect(page.locator('.cm-content')).toContainText('TYPED-BETWEEN-EDITS');
      await expect(page.locator('.cm-content')).toContainText('Edited opening line.');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('write_file commits only the file Claude wrote; a person\'s unsaved typing waits for the autosave', async ({ page, request }) => {
    test.setTimeout(120_000); // waits out the real 20 s autosave debounce
    const id = await createProject(request, 'MCP Commit Scope');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });

      await openProject(page, id);
      await typeAtEnd(page, 'HUMAN-TYPED-LINE ');
      // past the 1.5 s store debounce (on disk, uncommitted), well inside the
      // 20 s autosave: the write's commit below must leave this line alone
      await page.waitForTimeout(2000);

      const wrote = await call(client, 'write_file', { project: id, path: 'notes.tex', content: 'Reviewer notes.\n', message: 'Add reviewer notes' });
      expect(wrote.isError).toBeFalsy();
      expect(wrote.body.commit).toMatch(/^[0-9a-f]{7,}$/);
      expect(wrote.body.branch).toBe('main');

      const patchOf = async (hash: string): Promise<string> => (await (await request.get(`/api/projects/${id}/commit/${hash}/diff`)).json()).patch;
      let log: Array<{ hash: string; author: string; message: string }> = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      const claude = log.filter((c) => c.author === 'Claude');
      expect(claude).toHaveLength(1);
      expect(claude[0].message).toBe('Add reviewer notes');
      const claudePatch = await patchOf(claude[0].hash);
      expect(claudePatch).toContain('+Reviewer notes.');
      // added lines only: the typed line may appear as unchanged hunk context
      expect(claudePatch).not.toMatch(/^\+.*HUMAN-TYPED-LINE/m);
      for (const c of log) expect(await patchOf(c.hash)).not.toMatch(/^\+.*HUMAN-TYPED-LINE/m);

      // the write has already committed itself, so a checkpoint is a result,
      // not a failure — and it never sweeps the person's file
      const again = await call(client, 'commit', { project: id, message: 'Nothing new' });
      expect(again.isError).toBeFalsy();
      expect(again.body.committed).toBe(false);
      expect(again.body.hash).toBeNull();
      expect(again.body.files).toHaveLength(0);
      expect(typeof again.body.note).toBe('string');
      expect(again.body.note).toContain(again.body.head);
      const afterAgain: Array<{ hash: string }> = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      expect(afterAgain).toHaveLength(log.length);

      // the person's line reaches history on its own, anonymously
      let human: { hash: string; author: string; message: string } | undefined;
      await expect.poll(async () => {
        log = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
        for (const c of log.filter((x) => x.message === 'aldine: autosave')) {
          if (/^\+.*HUMAN-TYPED-LINE/m.test(await patchOf(c.hash))) { human = c; return true; }
        }
        return false;
      }, { timeout: 60_000, intervals: [1000] }).toBe(true);
      expect(human!.author).not.toBe('Claude');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('commit titles follow each write\'s own intent: a checkpoint never inherits the next tool\'s message', async ({ request }) => {
    const id = await createProject(request, 'MCP Intent Titles');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const edit = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve markedly across trials.' }],
        message: 'Strengthen the results claim',
      });
      expect(edit.isError).toBeFalsy();
      const notes = await call(client, 'write_file', { project: id, path: 'notes.tex', content: 'Reviewer notes.\n', message: 'Add reviewer notes' });
      expect(notes.isError).toBeFalsy();
      // a second edit of main.tex checkpoints the first under ITS message
      const again = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line.', replacement: 'Edited opening line.' }],
      });
      expect(again.isError).toBeFalsy();

      // each write committed before it answered: nothing to wait for
      const log: Array<{ hash: string; author: string; message: string }> = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
      expect(log.filter((c) => c.author === 'Claude')).toHaveLength(3);
      const statOf = async (hash: string): Promise<string> => (await (await request.get(`/api/projects/${id}/commit/${hash}/diff`)).json()).stat;
      const byMessage: Record<string, string> = {};
      for (const c of log.filter((x) => x.author === 'Claude')) byMessage[c.message] = await statOf(c.hash);
      expect(Object.keys(byMessage).sort()).toEqual(['Add reviewer notes', 'Edit main.tex', 'Strengthen the results claim']);
      expect(byMessage['Strengthen the results claim']).toContain('main.tex');
      expect(byMessage['Strengthen the results claim']).not.toContain('notes.tex');
      expect(byMessage['Add reviewer notes']).toContain('notes.tex');
      expect(byMessage['Add reviewer notes']).not.toContain('main.tex');
      expect(byMessage['Edit main.tex']).toContain('main.tex');
      expect(byMessage['Edit main.tex']).not.toContain('notes.tex');
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
      // a DOI doi.org does not know is "not found" with the query, never an outage
      const unregistered = await call(client, 'references_add', { project: id, query: '10.1145/mock.unregistered' });
      expect(unregistered.isError).toBeTruthy();
      expect(unregistered.text).toMatch(/No reference found for "10.1145\/mock.unregistered"/);
      expect(unregistered.text).not.toMatch(/lookup failed/);

      // Crossref's blob is made typesettable under pdflatex and biber: the
      // emoji goes, the Greek letter becomes its macro, month = June becomes
      // jun, and the entry is keyed and laid out like a synthesized one
      const parrot = await call(client, 'references_add', { project: id, query: '10.1145/mock.parrot' });
      expect(parrot.isError).toBeFalsy();
      expect(parrot.body.key).toBe('bender2021');
      const bibWithParrot = await (await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`)).text();
      expect(bibWithParrot).not.toMatch(/[\u{10000}-\u{10FFFF}]/u);
      expect(bibWithParrot).toContain('Stochastic Parrots: $\\alpha$ Models');
      expect(bibWithParrot).toMatch(/^  month\s+= jun,$/m);
      expect(bibWithParrot).toMatch(/^@article\{bender2021,\n  title\s+= \{/m);

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

  test('conflicts are per file: references_add and edit_file share one read, a same-file rewrite conflicts, a revert conflicts everything', async ({ request }) => {
    const id = await createProject(request, 'MCP Per-file versions');
    const client = await connect();
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
      const read = await call(client, 'read_file', { project: id, path: 'main.tex' });
      expect(read.isError).toBeFalsy();
      const base: number = read.body.contentVersion;
      expect(typeof read.body.fileVersion).toBe('number');
      expect(read.body.fileVersion).toBeLessThanOrEqual(base);

      // dogfood session 1, friction #1: a model runs two tools in parallel on
      // different files — the bib write must not stale the main.tex base
      const [added, edit] = await Promise.all([
        call(client, 'references_add', { project: id, query: '10.1145/mock.12345' }),
        call(client, 'edit_file', {
          project: id, path: 'main.tex',
          edits: [{ quote: 'Stable opening line.', replacement: 'Stable opening line, edited once.' }],
          base_version: base,
        }),
      ]);
      expect(added.isError).toBeFalsy();
      expect(added.body).toMatchObject({ key: 'doe2020', duplicate: false });
      expect(edit.isError).toBeFalsy();
      expect(edit.body.error).toBeUndefined();
      expect(edit.body.applied).toBe(1);
      expect(edit.body.fileVersion).toBeLessThanOrEqual(edit.body.contentVersion);

      // the same base is stale once main.tex itself changed
      const again = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line, edited once.', replacement: 'Stable opening line, edited twice.' }],
        base_version: base,
      });
      expect(again.isError).toBeFalsy();
      expect(again.body.error).toBe('version_conflict');
      expect(again.body.fileVersion).toBeGreaterThan(base);
      expect(again.body.currentVersion).toBeGreaterThanOrEqual(again.body.fileVersion);
      // the conflict says which rule fired and carries the same echo as a success
      expect(again.body.reason).toMatch(/"main\.tex" changed after version/);
      expect(again.body.path).toBe('main.tex');
      expect(again.body.branch).toBe('main');
      expect(typeof again.body.head).toBe('string');
      const newer = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: 'Stable opening line, edited once.', replacement: 'Stable opening line, edited twice.' }],
        base_version: again.body.currentVersion + 500,
      });
      expect(newer.body.error).toBe('version_conflict');
      expect(newer.body.reason).toMatch(/newer than the branch's contentVersion/);
      const onDisk = await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
      expect(onDisk).toContain('edited once');
      expect(onDisk).not.toContain('edited twice');

      // REST carries both versions and applies the same per-file rule
      const bibRes = await request.get(`/api/projects/${id}/file?branch=main&path=references.bib`);
      expect(bibRes.ok()).toBeTruthy();
      const bibV = Number(bibRes.headers()['x-aldine-content-version']);
      const bibFv = Number(bibRes.headers()['x-aldine-file-version']);
      expect(Number.isFinite(bibV)).toBeTruthy();
      expect(Number.isFinite(bibFv)).toBeTruthy();
      expect(bibFv).toBeLessThanOrEqual(bibV);
      const bibText = await bibRes.text();
      const mainPut = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: onDisk.replace('edited once', 'edited over REST') } });
      expect(mainPut.ok()).toBeTruthy();
      const bibPut = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'references.bib', content: bibText + '% touched\n', baseVersion: bibV } });
      expect(bibPut.ok()).toBeTruthy();

      // a git revert rewrites the tree: every path counts as changed. The
      // agent's edits committed on their own; the REST rewrites above are
      // checkpointed here, and that newest commit is the one reverted (an
      // older one would conflict with the later same-line rewrite).
      const committed = await request.post(`/api/projects/${id}/commit`, { data: { branch: 'main', message: 'Land the per-file edits' } });
      expect(committed.ok()).toBeTruthy();
      expect((await committed.json()).committed).toBe(true);
      const hash: string = (await (await request.get(`/api/projects/${id}/log?branch=main`)).json())[0].hash;
      expect(hash).toMatch(/^[0-9a-f]{7,}$/);
      const pre = await call(client, 'read_file', { project: id, path: 'main.tex' });
      const V: number = pre.body.contentVersion;
      const revert = await request.post(`/api/projects/${id}/revert`, { data: { branch: 'main', hashes: [hash] } });
      expect(revert.ok()).toBeTruthy();
      expect((await revert.json()).ok).toBe(true);
      const reverted = await call(client, 'read_file', { project: id, path: 'main.tex' });
      const firstLine: string = reverted.body.content.split('\n')[0];
      expect(firstLine.length).toBeGreaterThanOrEqual(8);
      const stale = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: firstLine, replacement: '\\documentclass[11pt]{article}' }],
        base_version: V,
      });
      expect(stale.isError).toBeFalsy();
      expect(stale.body.error).toBe('version_conflict');
      expect(stale.body.fileVersion).toBeGreaterThan(V);
      const fresh = await call(client, 'edit_file', {
        project: id, path: 'main.tex',
        edits: [{ quote: firstLine, replacement: '\\documentclass[11pt]{article}' }],
        base_version: reverted.body.contentVersion,
      });
      expect(fresh.isError).toBeFalsy();
      expect(fresh.body.applied).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('a rootless project says so; refusals name their cause; a fatal typeset keeps the previous PDF as stale', async ({ request }) => {
    test.setTimeout(300_000); // two real latexmk runs
    const created = await request.post('/api/projects', { data: { name: 'MCP Rootless', template: 'blank' } });
    expect(created.ok()).toBeTruthy();
    const id = (await created.json()).id as string;
    const client = await connect();
    try {
      // no .tex yet: compile and wordcount say so — never "the compiler is down", never "0 words"
      const noTex = await call(client, 'compile', { project: id });
      expect(noTex.isError).toBeTruthy();
      expect(noTex.text).toMatch(/no \.tex file to typeset on main/);
      expect(noTex.text).not.toMatch(/compiler/);
      const noWords = await call(client, 'wordcount', { project: id });
      expect(noWords.isError).toBeTruthy();
      expect(noWords.text).toMatch(/no main document yet/);

      // the first .tex written through the tools becomes the main document
      const wrote = await call(client, 'write_file', { project: id, path: 'paper.tex', content: MAIN });
      expect(wrote.isError).toBeFalsy();
      expect(wrote.body.newRoot).toBe('paper.tex');
      const struct = await call(client, 'project_structure', { project: id });
      expect(struct.body.rootFile).toBe('paper.tex');
      expect(struct.body.files.find((f: any) => f.path === 'paper.tex').binary).toBe(false);
      const wc = await call(client, 'wordcount', { project: id });
      expect(wc.isError).toBeFalsy();
      expect(wc.body.rootFile).toBe('paper.tex');
      expect(wc.body.total).toBeGreaterThan(0);

      const good = await call(client, 'compile', { project: id });
      expect(good.isError).toBeFalsy();
      expect(good.body.ok).toBe(true);
      expect(good.body.errorsTotal).toBe(0);
      expect(good.body.warningsTotal).toBe(0);
      expect(good.body.pdfStale).toBe(false);
      const goodT = new URL(good.body.pdfUrl).searchParams.get('t');

      // a missing package stops the engine before any page: no PDF from this
      // run, so the result is stale and links the previous run's PDF
      const fatalSrc = MAIN.replace('\\begin{document}', '\\usepackage{nonexistentpkgxyz}\n\\begin{document}');
      const rewrote = await call(client, 'write_file', { project: id, path: 'paper.tex', content: fatalSrc, base_version: good.body.contentVersion });
      expect(rewrote.isError).toBeFalsy();
      const fatal = await call(client, 'compile', { project: id });
      expect(fatal.isError).toBeFalsy();
      expect(fatal.body.ok).toBe(false);
      expect(fatal.body.pdfStale).toBe(true);
      expect(fatal.body.pages).toBeNull();
      expect(fatal.body.errorsTotal).toBeGreaterThanOrEqual(1);
      expect(fatal.body.hint).toMatch(/nonexistentpkgxyz/);
      expect(new URL(fatal.body.pdfUrl).searchParams.get('t')).toBe(goodT);
      expect(fatal.body.typesetAt).toBe(good.body.typesetAt);

      // refusals name what was asked and what exists
      await call(client, 'write_file', { project: id, path: 'sections/intro.tex', content: 'Repeated sentence here.\nRepeated sentence here.\n' });
      const onFolder = await call(client, 'write_file', { project: id, path: 'sections', content: 'x\n' });
      expect(onFolder.isError).toBeTruthy();
      expect(onFolder.text).toMatch(/"sections" is a folder/);
      const underFile = await call(client, 'write_file', { project: id, path: 'paper.tex/inside.tex', content: 'x\n' });
      expect(underFile.isError).toBeTruthy();
      expect(underFile.text).toMatch(/"paper\.tex" is a file, so "paper\.tex\/inside\.tex" cannot be created/);
      const slash = await call(client, 'write_file', { project: id, path: 'figs/', content: 'x\n' });
      expect(slash.isError).toBeTruthy();
      expect(slash.text).toMatch(/must name a file, not a folder/);
      const folderRead = await call(client, 'read_file', { project: id, path: 'sections' });
      expect(folderRead.isError).toBeTruthy();
      expect(folderRead.text).toMatch(/"sections" is a folder on main/);
      const noBranch = await call(client, 'read_file', { project: id, path: 'paper.tex', branch: 'nope' });
      expect(noBranch.isError).toBeTruthy();
      expect(noBranch.text).toMatch(/No branch "nope" in this project — branches: main/);
      const noProject = await call(client, 'project_structure', { project: 'zzzzzzzzzz' });
      expect(noProject.isError).toBeTruthy();
      expect(noProject.text).toMatch(/No project "zzzzzzzzzz"/);
      expect(noProject.text).toMatch(/list_projects/);
      const dotdot = await call(client, 'read_file', { project: id, path: '../paper.tex' });
      expect(dotdot.isError).toBeTruthy();
      expect(dotdot.text).toMatch(/cannot contain "\.\."/);

      // a windowed read echoes its window; a window past the end is refused
      const win = await call(client, 'read_file', { project: id, path: 'sections/intro.tex', from_line: 2, to_line: 50 });
      expect(win.isError).toBeFalsy();
      expect(win.body.from_line).toBe(2);
      expect(win.body.to_line).toBe(win.body.totalLines);
      const past = await call(client, 'read_file', { project: id, path: 'sections/intro.tex', from_line: 500 });
      expect(past.isError).toBeTruthy();
      expect(past.text).toMatch(/from_line 500 is past the end/);

      // an ambiguous quote is ambiguous_anchor, and the candidates carry the occurrence to resend
      const amb = await call(client, 'edit_file', { project: id, path: 'sections/intro.tex', edits: [{ quote: 'Repeated sentence here.', replacement: 'Second one.' }] });
      expect(amb.isError).toBeFalsy();
      expect(amb.body.error).toBe('ambiguous_anchor');
      expect(amb.body.candidates.map((c: any) => c.occurrence)).toEqual([1, 2]);
      expect(amb.body.path).toBe('sections/intro.tex');
      const picked = await call(client, 'edit_file', { project: id, path: 'sections/intro.tex', edits: [{ quote: 'Repeated sentence here.', replacement: 'Second one.', occurrence: 2 }] });
      expect(picked.isError).toBeFalsy();
      expect(picked.body.applied).toBe(1);
      expect(await (await request.get(`/api/projects/${id}/file?branch=main&path=sections/intro.tex`)).text()).toBe('Repeated sentence here.\nSecond one.\n');
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, id);
    }
  });

  test('trash_project: only an agent-made project, soft-deleted into the workspace trash, restorable over REST', async ({ request }) => {
    const human = await request.post('/api/projects', { data: { name: 'MCP Human paper' } });
    expect(human.ok()).toBeTruthy();
    const humanId = (await human.json()).id as string;
    const client = await connect();
    let agentId = '';
    try {
      const made = await call(client, 'create_project', { name: 'MCP Scratch' });
      expect(made.isError).toBeFalsy();
      agentId = made.body.id as string;
      const listed = await call(client, 'list_projects', {});
      const rows = listed.body as Array<{ id: string; agentCreated: boolean }>;
      expect(rows.find((r) => r.id === agentId)?.agentCreated).toBe(true);
      expect(rows.find((r) => r.id === humanId)?.agentCreated).toBe(false);

      const refused = await call(client, 'trash_project', { project: humanId });
      expect(refused.isError).toBeTruthy();
      expect(refused.text).toMatch(/created through the Agent API/);
      expect((await request.get(`/api/projects/${humanId}`)).ok()).toBeTruthy();

      const trashed = await call(client, 'trash_project', { project: agentId });
      expect(trashed.isError).toBeFalsy();
      expect(trashed.body.trashed).toBe(true);
      expect(Date.parse(trashed.body.restorableUntil)).toBeGreaterThan(Date.now());
      const gone = await call(client, 'project_structure', { project: agentId });
      expect(gone.isError).toBeTruthy();
      const trash = (await (await request.get('/api/projects/trash')).json()) as Array<{ id: string }>;
      expect(trash.some((p) => p.id === agentId)).toBe(true);

      expect((await request.post(`/api/projects/${agentId}/restore`)).ok()).toBeTruthy();
      const back = await call(client, 'project_structure', { project: agentId });
      expect(back.isError).toBeFalsy();
    } finally {
      await client.close().catch(() => {});
      await cleanup(request, humanId);
      if (agentId) await cleanup(request, agentId);
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
