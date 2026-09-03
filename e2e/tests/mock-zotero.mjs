/** Mock Zotero Web API + DOI/arXiv reference lookup for e2e tests. */
import http from 'node:http';

const KEY = 'test-key-123';
const USER = 777;

const BIB = `@article{turing1950,
  author = {Turing, Alan M.},
  title = {Computing Machinery and Intelligence},
  journaltitle = {Mind},
  year = {1950},
}

@book{shannon1948,
  author = {Shannon, Claude E.},
  title = {A Mathematical Theory of Communication},
  year = {1948},
}
`;

const server = http.createServer((req, res) => {
  const auth = req.headers['zotero-api-key'];
  const url = new URL(req.url, 'http://x');
  const send = (code, body, headers = {}) => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
    res.end(buf);
  };

  // --- Mock Anthropic Messages API (for AI error-fix tests) ---
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const jsonText = JSON.stringify({
        explanation: 'The command \\thisisnotacommand is not defined. Removing it fixes the compile.',
        fixes: [{ file: 'main.tex', find: '\\thisisnotacommand', replace: '', note: 'remove undefined command' }],
      });
      send(200, {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: jsonText }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    });
    return;
  }

  // --- Mock OpenAlex (search + single work) ---
  if (url.pathname === '/works') {
    return send(200, { meta: { count: 2 }, results: [
      { id: 'https://openalex.org/W111', doi: 'https://doi.org/10.1145/mock.search1', title: 'A Searchable Mock Paper', publication_year: 2021,
        authorships: [{ author: { display_name: 'Jane Roe' } }, { author: { display_name: 'John Doe' } }],
        primary_location: { source: { display_name: 'Mock Journal' } } },
      { id: 'https://openalex.org/W222', doi: null, title: 'A DOI-less Mock Paper', publication_year: 2019,
        authorships: [{ author: { display_name: 'Alice Smith' } }], primary_location: { source: { display_name: 'Mock Proc.' } } },
    ] });
  }
  if (url.pathname.startsWith('/works/W')) {
    const id = url.pathname.split('/').pop();
    if (id === 'W222') return send(200, { id: 'https://openalex.org/W222', doi: null, title: 'A DOI-less Mock Paper', publication_year: 2019,
      authorships: [{ author: { display_name: 'Alice Smith' } }], primary_location: { source: { display_name: 'Mock Proc.' } } });
    return send(200, { id: 'https://openalex.org/W111', doi: 'https://doi.org/10.1145/mock.search1', title: 'A Searchable Mock Paper', publication_year: 2021,
      authorships: [{ author: { display_name: 'Jane Roe' } }], primary_location: { source: { display_name: 'Mock Journal' } } });
  }

  // --- DOI content negotiation (any 10.x path) ---
  // Title carries an HTML &amp; like real CrossRef output — the server must
  // decode + LaTeX-escape it so the .bib compiles (regression: a bare & is an
  // alignment tab and breaks the whole document).
  if (url.pathname.startsWith('/10.')) {
    return send(200, `@article{doe2020,\n  title = {Knowledge Discovery &amp; Data Mining},\n  author = {Doe, Jane},\n  year = {2020},\n  doi = {${url.pathname.slice(1)}},\n}`);
  }
  // --- arXiv Atom feed ---
  if (url.pathname === '/api/query') {
    const id = url.searchParams.get('id_list') || '0000.00000';
    return send(200, `<?xml version="1.0"?>\n<feed><title>arXiv Query</title><entry><title>A Mock arXiv Paper</title><published>2019-01-01T00:00:00Z</published><author><name>Alice Smith</name></author><author><name>Bob Jones</name></author></entry></feed>`);
  }

  if (auth !== KEY) return send(403, { error: 'bad key' });

  if (url.pathname === '/keys/current') {
    return send(200, { userID: USER, username: 'testuser', access: { user: { library: true } } });
  }
  if (url.pathname === `/users/${USER}/groups`) {
    return send(200, [{ id: 4242, data: { name: 'Space Lab' } }]);
  }
  if (url.pathname.endsWith('/collections')) {
    return send(200, [
      { key: 'COLL1', data: { name: 'CRDT Research', parentCollection: false } },
    ]);
  }
  // (references DOI/arXiv mock handled by a separate server below; keep Zotero paths here)
  if (url.pathname.includes('/items/top')) {
    if (req.headers['if-modified-since-version'] && Number(req.headers['if-modified-since-version']) >= 42) {
      res.writeHead(304); return res.end();
    }
    if (url.searchParams.get('format') === 'biblatex') {
      return send(200, BIB, { 'Last-Modified-Version': '42', 'Total-Results': '2' });
    }
    return send(200, { items: [] }, { 'Last-Modified-Version': '42', 'Total-Results': '0' });
  }
  send(404, { error: 'not found' });
});

const port = Number(process.env.E2E_MOCK_PORT || 4919);
server.listen(port, () => console.log(`[mock-zotero] on :${port}`));
