import * as store from './store.js';
import { ensureWorktree, checkpointPathsHeld, withRepoLock } from './gitops.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, scheduleCommit } from './collab.js';
import { bibKeys } from './bib.js';

/**
 * Resolve a DOI, doi.org URL, or arXiv id to a BibTeX entry using free public
 * endpoints — no account, complements the Zotero integration.
 */

const ARXIV_RE = /(?:arxiv:|arxiv\.org\/abs\/)?(\d{4}\.\d{4,5})(v\d+)?/i;
const DOI_RE = /10\.\d{4,9}\/[^\s"']+/;

const DOI_BASE = process.env.DOI_API_BASE || 'https://doi.org';
const ARXIV_BASE = process.env.ARXIV_API_BASE || 'https://export.arxiv.org';
const OPENALEX_BASE = process.env.OPENALEX_API_BASE || 'https://api.openalex.org';

/** Decode the HTML entities upstream metadata (CrossRef, arXiv, OpenAlex) ships. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Escape LaTeX specials that would break a compile, skipping already-escaped ones. */
function latexEscape(s: string): string {
  return s.replace(/(\\?)([&%$#_])/g, (_, bs, ch) => (bs ? bs + ch : `\\${ch}`));
}

/** A field value built from upstream metadata: HTML-decode, then LaTeX-escape. */
function bibField(s: string): string {
  return latexEscape(unescapeHtml(s));
}

/**
 * Sanitize a raw BibTeX blob (e.g. CrossRef via doi.org): decode HTML entities
 * and escape bare & / % inside brace-delimited values so the entry compiles.
 * A bare `&` is read by LaTeX as an alignment tab — the classic broken-.bib bug.
 */
function sanitizeBibtex(bib: string): string {
  return unescapeHtml(bib).replace(/(\\?)([&%])/g, (_, bs, ch) => (bs ? bs + ch : `\\${ch}`));
}

export interface SearchHit { id: string; doi: string | null; title: string; authors: string; year: number | null; venue: string }

/** Full-text search across OpenAlex (250M+ works, no key). */
export async function searchWorks(query: string, limit = 12): Promise<SearchHit[]> {
  const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(query)}&per_page=${limit}&mailto=aldine@localhost`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const data = JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as { results?: Array<Record<string, unknown>> };
  return (data.results || []).map((w) => {
    const authorships = (w.authorships as Array<{ author?: { display_name?: string } }> | undefined) || [];
    const authors = authorships.slice(0, 4).map((a) => a.author?.display_name).filter(Boolean).join(', ') + (authorships.length > 4 ? ', et al.' : '');
    const loc = (w.primary_location as { source?: { display_name?: string } } | undefined)?.source?.display_name;
    return {
      id: String(w.id || '').split('/').pop() || '',
      doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null,
      title: String(w.title || w.display_name || 'Untitled'),
      authors,
      year: (w.publication_year as number) ?? null,
      venue: loc || '',
    };
  });
}

/** BibTeX for an OpenAlex work id (Wxxxx): prefer its DOI, else synthesize from metadata. */
async function fetchOpenAlex(id: string): Promise<string | null> {
  const res = await fetch(`${OPENALEX_BASE}/works/${encodeURIComponent(id)}?mailto=aldine@localhost`);
  if (!res.ok) throw new Error(`OpenAlex lookup failed (HTTP ${res.status})`);
  const w = JSON.parse(await readCapped(res)) as Record<string, unknown>;
  const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null;
  if (doi) { try { const b = await fetchDoi(doi); if (b) return b; } catch { /* fall through to synthesis */ } }
  const authorships = (w.authorships as Array<{ author?: { display_name?: string } }> | undefined) || [];
  const authorField = authorships.map((a) => {
    const n = a.author?.display_name || '';
    const parts = n.split(' ');
    const last = parts.pop();
    return last ? `${last}, ${parts.join(' ')}` : n;
  }).join(' and ');
  const year = (w.publication_year as number) ?? '';
  const title = String(w.title || w.display_name || 'Untitled');
  const first = authorships[0]?.author?.display_name?.split(' ').pop()?.toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const venue = (w.primary_location as { source?: { display_name?: string } } | undefined)?.source?.display_name || '';
  return `@article{${first}${year},
  title   = {${bibField(title)}},
  author  = {${bibField(authorField)}},
  year    = {${year}},${venue ? `\n  journaltitle = {${bibField(venue)}},` : ''}
  url     = {${w.id}},
}`;
}

export async function fetchBibEntry(query: string): Promise<string | null> {
  // OpenAlex work id (openalex:W… or a full openalex.org/W… URL)
  const oa = query.match(/(?:openalex[:/]|openalex\.org\/)?(W\d{2,})/i);
  if (/openalex/i.test(query) && oa) return fetchOpenAlex(oa[1]);

  // A real DOI (starts with 10.) wins even if it mentions arXiv (e.g. 10.48550/arXiv.1706.03762).
  const doiMatch = query.match(DOI_RE);
  if (doiMatch) return fetchDoi(doiMatch[0]);

  // an explicit arXiv reference or a bare arXiv id
  const arxiv = query.match(ARXIV_RE);
  if (arxiv) return fetchArxiv(arxiv[1]);

  // a bare OpenAlex id
  if (oa) return fetchOpenAlex(oa[1]);
  return null;
}

/** Stream a response body and abort as soon as it exceeds the cap (a chunked/
 *  unknown-length upstream can't OOM us by omitting content-length). */
async function readCapped(res: Response, cap = 2 * 1024 * 1024): Promise<string> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > cap) throw new Error('reference response too large');
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel(); throw new Error('reference response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchDoi(doi: string): Promise<string | null> {
  const res = await fetch(`${DOI_BASE}/${encodeURIComponent(doi)}`, {
    headers: { Accept: 'application/x-bibtex; charset=utf-8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`DOI lookup failed (HTTP ${res.status})`);
  const bib = (await readCapped(res)).trim();
  return bib.startsWith('@') ? sanitizeBibtex(bib) : null;
}

async function fetchArxiv(id: string): Promise<string | null> {
  const res = await fetch(`${ARXIV_BASE}/api/query?id_list=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`arXiv lookup failed (HTTP ${res.status})`);
  const feed = await readCapped(res);
  // parse within the <entry> element only — the feed also has its own <title>
  const xml = (feed.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!xml) return null;
  const pick = (tag: string) => (xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.trim();
  const title = pick('title')?.replace(/\s+/g, ' ');
  if (!title) return null;
  const published = pick('published') || '';
  const year = published.slice(0, 4);
  const authors = Array.from(xml.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
  const authorField = authors.map((a) => {
    const parts = a.split(' ');
    const last = parts.pop();
    return `${last}, ${parts.join(' ')}`;
  }).join(' and ');
  const first = authors[0]?.split(' ').pop()?.toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const key = `${first}${year}`;
  return `@article{${key},
  title        = {${bibField(title)}},
  author       = {${bibField(authorField)}},
  year         = {${year}},
  eprint       = {${id}},
  archivePrefix = {arXiv},
  url          = {https://arxiv.org/abs/${id}},
}`;
}

export interface AddedReference { key: string; bibFile: string; duplicate: boolean }

/**
 * Look a query up and append the entry to `bibFile` on the branch (created
 * if missing), skipping a key that is already there. Shared by the REST
 * route and the MCP tool — the caller validates `bibFile` and takes the
 * rate-limit token. Returns null when nothing resolves; upstream failures
 * throw with a user-readable message. With `author` set the write is
 * checkpointed and attributed like every other agent mutation, so the
 * attributed commit carries only the new entry.
 */
export async function addReference(projectId: string, branch: string, query: string, bibFile: string, author?: string): Promise<AddedReference | null> {
  const entry = await fetchBibEntry(query.trim());
  if (!entry) return null;
  await ensureWorktree(projectId, branch);
  // Synchronous on purpose: with an author it runs inside the repo lock, and
  // an await between the write and scheduleCommit would let an autosave
  // stage the entry before it is attributed.
  const append = (): AddedReference => {
    let existing = '';
    try { existing = store.readFile(projectId, branch, bibFile).toString('utf8'); } catch { /* new file */ }
    // key-only dedup via the shared bibKeys scanner — consistent with the
    // /bib index (skips @comment/@string) but without parsing every field
    // of every existing entry just to compare keys.
    const key = [...bibKeys(entry)][0] ?? '';
    if (key && bibKeys(existing).has(key)) return { key, bibFile, duplicate: true };
    store.writeFile(projectId, branch, bibFile, existing.trimEnd() + '\n\n' + entry.trim() + '\n');
    refreshBranchDocsFromDisk(projectId, branch, [bibFile]);
    if (author) scheduleCommit(projectId, branch, `Add reference ${key || bibFile}`, author, [bibFile]);
    else scheduleCommit(projectId, branch);
    return { key, bibFile, duplicate: false };
  };
  if (!author) return append();
  return withRepoLock(projectId, async () => {
    flushBranchDocs(projectId, branch);
    await checkpointPathsHeld(projectId, branch, [bibFile]);
    flushBranchDocs(projectId, branch);
    return append();
  });
}
