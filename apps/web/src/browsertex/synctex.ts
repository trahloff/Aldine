/**
 * SyncTeX lookups in the browser, for PDFs typeset here (and published ones
 * this tab follows): no `synctex` binary, no server round trip. Answers in
 * the shape the compiler's /synctex does — forward
 * [{ page, x, y, h, v, W, H }], inverse [{ input, line, column }] — in PDF
 * big points from the page's top left, as `synctex view|edit` print them.
 */

/** Joins path segments, resolving "." and ".."; null when ".." climbs out. */
function normalize(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!out.length) return null; out.pop(); } else out.push(p);
  }
  return out.join('/');
}

/** A box or point the engine recorded: in big points, v down from the top. */
interface Rec {
  kind: string;
  input: number;
  line: number;
  h: number;
  v: number;
  W: number;
  H: number;
  D: number;
  /** Index of the enclosing hbox/vbox in the page's list, or -1. */
  parent: number;
}

export interface Parsed { inputs: Map<number, string>; pages: Map<number, Rec[]> }

const SP_PER_BP = 65781.76;

export function parseSynctex(text: string): Parsed {
  const inputs = new Map<number, string>();
  const pages = new Map<number, Rec[]>();
  let unit = 1, mag = 1, xOff = 0, yOff = 0;
  let page: Rec[] | null = null;
  const stack: number[] = [];
  const scale = (n: string, off = 0) => ((Number(n) * unit + off) * mag) / SP_PER_BP;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line[0];
    if (page) {
      if (c === '}') { page = null; stack.length = 0; continue; }
      if (c === ']' || c === ')') { stack.pop(); continue; }
      // [ ( open a box; v h void boxes; x k g $ points: "tag,line(,col):h,v(:W,H,D)"
      const m = /^([[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(line);
      if (!m) continue;
      const rec: Rec = {
        kind: m[1], input: Number(m[2]), line: Number(m[3]),
        h: scale(m[4], xOff), v: scale(m[5], yOff),
        W: m[6] ? scale(m[6]) : 0, H: m[7] ? scale(m[7]) : 0, D: m[8] ? scale(m[8]) : 0,
        parent: stack.length ? stack[stack.length - 1] : -1,
      };
      page.push(rec);
      if (c === '[' || c === '(') stack.push(page.length - 1);
      continue;
    }
    if (c === '{') { page = []; pages.set(Number(line.slice(1)), page); continue; }
    const kv = /^([A-Za-z ]+):(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'Input') {
      const i = value.indexOf(':');
      inputs.set(Number(value.slice(0, i)), value.slice(i + 1));
    }
    else if (key === 'Unit') unit = Number(value) || 1;
    else if (key === 'Magnification') mag = (Number(value) || 1000) / 1000;
    else if (key === 'X Offset') xOff = Number(value) || 0;
    else if (key === 'Y Offset') yOff = Number(value) || 0;
  }
  return { inputs, pages };
}

/**
 * The project file an input record names, project-relative, or null for an
 * installed file. Engines record the path they opened, often absolute inside
 * a directory only they know (a browser's in-memory one included), so the
 * longest suffix that names a file of the checkout wins.
 */
export function projectPath(recorded: string, rootDir: string, exists: (rel: string) => boolean): string | null {
  const parts = recorded.split('/').filter((p) => p && p !== '.');
  if (!recorded.startsWith('/')) {
    const rel = normalize([...(rootDir ? rootDir.split('/') : []), ...parts]);
    return rel === null || rel.startsWith('../') ? null : rel;
  }
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(i).join('/');
    if (exists(rel)) return rel;
  }
  return null;
}

const isBox = (r: Rec) => r.kind === '(' || r.kind === 'h';

/** synctex view: where source file:line went in the PDF. */
export function forward(p: Parsed, inputIds: Set<number>, line: number) {
  // The line itself, else the nearest later line with output (a line of
  // markup alone, e.g. \begin{figure}, typesets nothing).
  let best: { page: number; rec: Rec; recs: Rec[]; line: number } | null = null;
  for (const [page, recs] of [...p.pages].sort((a, b) => a[0] - b[0])) {
    for (const rec of recs) {
      if (!inputIds.has(rec.input) || rec.line < line) continue;
      if (rec.kind === '[' || rec.kind === 'v' || rec.kind === 'h') continue;
      if (!best || rec.line < best.line) best = { page, rec, recs, line: rec.line };
      if (rec.line === line) break;
    }
    if (best?.line === line) break;
  }
  if (!best) return [];
  const records: Array<{ box: Rec; x: number; y: number }> = [];
  for (const rec of best.recs) {
    if (!inputIds.has(rec.input) || rec.line !== best.line || rec.kind === '[' || rec.kind === 'v' || rec.kind === 'h') continue;
    const box = isBox(rec) ? rec : rec.parent >= 0 ? best.recs[rec.parent] : rec;
    if (records.some((r) => r.box === box)) continue;
    records.push({ box, x: rec.h, y: rec.v });
  }
  return records.map(({ box, x, y }) => ({
    page: best!.page,
    x, y,
    h: box.h,
    v: box.v + box.D,
    W: box.W,
    H: box.H + box.D,
  }));
}

/** synctex edit: the source behind a point of a page. */
export function inverse(p: Parsed, page: number, x: number, y: number): { input: number; line: number } | null {
  const recs = p.pages.get(page);
  if (!recs?.length) return null;
  const dist = (r: Rec) => {
    const dx = x < r.h ? r.h - x : x > r.h + r.W ? x - (r.h + r.W) : 0;
    const dy = y < r.v - r.H ? r.v - r.H - y : y > r.v + r.D ? y - (r.v + r.D) : 0;
    return dx * dx + dy * dy * 4;
  };
  // Text sits in horizontal boxes: the innermost one around the point, else
  // the nearest, so a click in a margin or between paragraphs still lands on
  // a line of text rather than on the vertical glue around it.
  let box = -1;
  let boxScore = Infinity;
  recs.forEach((r, i) => {
    if (!isBox(r) || r.W <= 0 || r.line <= 0) return;
    const d = dist(r);
    const score = d === 0 ? -1 / (r.W * (r.H + r.D) + 1e-9) : d;
    if (score < boxScore) { box = i; boxScore = score; }
  });
  if (box < 0) return null;
  let best = recs[box];
  let bestD = Infinity;
  recs.forEach((r, i) => {
    if (r.parent !== box || isBox(r) || r.kind === '[' || r.kind === 'v' || r.line <= 0) return;
    const d = dist(r);
    if (d < bestD) { best = r; bestD = d; }
  });
  return { input: best.input, line: best.line };
}

export interface SynctexQuery { direction?: unknown; file?: unknown; line?: unknown; page?: unknown; x?: unknown; y?: unknown }

async function gunzip(gz: Uint8Array): Promise<string> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

const parsedCache = new WeakMap<Uint8Array, Promise<Parsed>>();

/** A lookup against one run's SyncTeX file; `files` are the project's paths. */
export async function synctexLookup(gz: Uint8Array, rootFile: string, files: Set<string>, q: SynctexQuery): Promise<Array<Record<string, number | string>>> {
  let parsing = parsedCache.get(gz);
  if (!parsing) { parsing = gunzip(gz).then(parseSynctex); parsedCache.set(gz, parsing); }
  const p = await parsing;
  const root = rootFile || 'main.tex';
  const rootDir = root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '';
  const named = new Map<number, string | null>();
  for (const [id, recorded] of p.inputs) named.set(id, projectPath(recorded, rootDir, (rel) => files.has(rel)));
  if (q.direction === 'forward') {
    const want = typeof q.file === 'string' && q.file ? normalize(q.file.split('/')) : root;
    const ids = new Set([...named].filter(([, rel]) => rel === want).map(([id]) => id));
    const line = Number(q.line);
    if (!ids.size || !Number.isFinite(line)) return [];
    return forward(p, ids, line);
  }
  const hit = inverse(p, Number(q.page), Number(q.x), Number(q.y));
  if (!hit) return [];
  return [{ input: named.get(hit.input) ?? p.inputs.get(hit.input) ?? '', line: hit.line, column: -1 }];
}
