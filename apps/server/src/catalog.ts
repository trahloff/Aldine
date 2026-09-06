/**
 * Venue templates generated from the classes installed in the compiler image.
 *
 * The compiler answers GET /catalog with the publisher classes it actually has
 * (see apps/compiler/catalog.js); this module turns each into a template: the
 * class's own sample document when the image ships one, otherwise a skeleton
 * built here. No publisher file is ever stored in this repo.
 *
 * A compiler that is old, down, or built on scheme-basic yields an empty list,
 * which is a normal answer: the folder templates stand on their own.
 */
import { config } from './config.js';
import type { TemplateCategory, TemplateInfo } from './templates.js';

export const VENUE_PREFIX = 'venue:';

interface CatalogClass {
  id: string;
  cls: string;
  kind: 'class' | 'style';
  pkg?: string;
  license?: string | null;
  version?: string | null;
  source?: string | null;
  sample?: { file: string; content: string } | null;
}

interface VenueMeta {
  name: string;
  category: TemplateCategory;
  description: string;
  icon?: string;
  /** Class options for the generated skeleton. */
  options?: string;
  /** BibTeX style for the generated skeleton; omitted when the venue uses biblatex. */
  bibStyle?: string;
  biblatexStyle?: string;
  /** Packages the class needs but does not load: mnras's bst calls
   *  \citeauthoryear, which only natbib defines. */
  packages?: string[];
  /** The class issues its own \bibliographystyle (jmlr); a second one is a
   *  BibTeX error, so the skeleton only names the .bib. */
  classSetsBibStyle?: boolean;
  /**
   * Where the title block goes. Getting this wrong is a fatal error on the
   * first compile, not a cosmetic difference: REVTeX's \author is undefined in
   * the preamble, and the AMS classes want the abstract before \maketitle.
   *  - 'frontmatter'    — title block inside \begin{frontmatter} (elsarticle)
   *  - 'inbody'         — title, author and affiliation after \begin{document},
   *                       abstract before \maketitle (REVTeX, AASTeX, acmart)
   *  - 'abstract-first' — title block in the preamble, abstract before
   *                       \maketitle (the AMS classes)
   *  - 'acm'            — acmart: every author needs an \affiliation with an
   *                       \institution and a \country, or the class errors
   * Anything else takes the plain article shape.
   */
  front?: 'frontmatter' | 'inbody' | 'abstract-first' | 'acm';
}

/**
 * Display metadata per venue id from the compiler's allowlist. Exported so the
 * registry test can hold these descriptions and templates/venues.json to one
 * story: a venue named here that also has a fetched tile would be two tiles for
 * the same submission with nothing to choose between them.
 */
export const INSTALLED_VENUES: Record<string, VenueMeta> = {
  elsarticle: { name: 'Elsevier journal', category: 'Journals', description: 'Elsevier submission with the elsarticle class.', icon: '📗', options: 'preprint,review,12pt', bibStyle: 'elsarticle-num', front: 'frontmatter' },
  ieeetran: { name: 'IEEE Transactions', category: 'Journals', description: 'IEEE journal submission with the IEEEtran class.', icon: '📘', options: 'journal', bibStyle: 'IEEEtran' },
  ieeeconf: { name: 'IEEE conference', category: 'Conferences', description: 'IEEE conference paper with the IEEEconf class.', icon: '📙', bibStyle: 'IEEEtran' },
  acmart: { name: 'ACM article', category: 'Conferences', description: 'ACM proceedings or journal paper with the acmart class.', icon: '📕', options: 'sigconf', bibStyle: 'ACM-Reference-Format', front: 'acm' },
  revtex: { name: 'APS and AIP (REVTeX)', category: 'Journals', description: 'Physics journals (Physical Review, AIP) with REVTeX.', icon: '⚛️', options: 'aps,pra,twocolumn', bibStyle: 'apsrev4-2', front: 'inbody' },
  agujournal: { name: 'AGU journal', category: 'Journals', description: 'American Geophysical Union submission.', icon: '🌍', options: 'draft', bibStyle: 'agufull08' },
  copernicus: { name: 'Copernicus journal', category: 'Journals', description: 'Copernicus Publications submission.', icon: '🛰', options: 'manuscript', bibStyle: 'copernicus' },
  llncs: { name: 'Springer LNCS', category: 'Conferences', description: 'Lecture Notes in Computer Science proceedings paper.', icon: '📓', bibStyle: 'splncs04' },
  svjour3: { name: 'Springer journal', category: 'Journals', description: 'Springer journal submission with svjour3.', icon: '📔', options: 'twocolumn', bibStyle: 'spmpsci' },
  mdpi: { name: 'MDPI journal', category: 'Journals', description: 'MDPI submission (Sensors, Applied Sciences and siblings).', icon: '📗', bibStyle: 'mdpi' },
  jmlr: { name: 'JMLR', category: 'Journals', description: 'Journal of Machine Learning Research submission.', icon: '🤖', classSetsBibStyle: true },
  amsart: { name: 'AMS article', category: 'Journals', description: 'American Mathematical Society article.', icon: '➗', bibStyle: 'amsplain', front: 'abstract-first' },
  siamart: { name: 'SIAM journal', category: 'Journals', description: 'Society for Industrial and Applied Mathematics submission.', icon: '📐', bibStyle: 'siamplain' },
  jfm: { name: 'Journal of Fluid Mechanics', category: 'Journals', description: 'Cambridge JFM submission.', icon: '🌊', bibStyle: 'jfm' },
  aastex: { name: 'AAS journals', category: 'Journals', description: 'American Astronomical Society journals (ApJ, AJ).', icon: '🔭', options: 'twocolumn', bibStyle: 'aasjournal', front: 'inbody' },
  mnras: { name: 'MNRAS', category: 'Journals', description: 'Monthly Notices of the Royal Astronomical Society.', icon: '✨', options: 'usenatbib', bibStyle: 'mnras' },
  apa7: { name: 'APA 7 manuscript', category: 'Journals', description: 'APA 7th edition manuscript for psychology journals.', icon: '🧠', options: 'man', biblatexStyle: 'apa' },
  achemso: { name: 'ACS journals', category: 'Journals', description: 'American Chemical Society journals (JACS and siblings).', icon: '⚗️', classSetsBibStyle: true },
  aiaa: { name: 'AIAA', category: 'Conferences', description: 'American Institute of Aeronautics and Astronautics paper.', icon: '🚀', bibStyle: 'aiaa' },
  ascelike: { name: 'ASCE journals', category: 'Journals', description: 'American Society of Civil Engineers submission.', icon: '🌉', options: 'Journal', classSetsBibStyle: true },
  asmeconf: { name: 'ASME conference', category: 'Conferences', description: 'ASME conference proceedings paper.', icon: '🔧', bibStyle: 'asmeconf' },
  spie: { name: 'SPIE', category: 'Conferences', description: 'SPIE proceedings paper.', icon: '🔬', bibStyle: 'spiebib' },
  neurips: { name: 'NeurIPS', category: 'Conferences', description: 'Neural Information Processing Systems submission.', icon: '🧠', bibStyle: 'plainnat' },
  iclr: { name: 'ICLR', category: 'Conferences', description: 'International Conference on Learning Representations submission.', icon: '🧩', bibStyle: 'plainnat' },
  acl: { name: 'ACL', category: 'Conferences', description: 'ACL, EMNLP and NAACL submission.', icon: '💬', bibStyle: 'acl_natbib' },
  aaai: { name: 'AAAI', category: 'Conferences', description: 'AAAI conference submission.', icon: '🎓', bibStyle: 'aaai' },
  usenix: { name: 'USENIX', category: 'Conferences', description: 'USENIX ATC, OSDI, NSDI and FAST submission.', icon: '🔐', bibStyle: 'plain' },
  cvpr: { name: 'CVPR', category: 'Conferences', description: 'CVPR submission.', icon: '👁', bibStyle: 'ieee_fullname' },
};

/** TeX Live license ids → the text everyone links to. */
const LICENSE_URLS: Record<string, string> = {
  lppl: 'https://www.latex-project.org/lppl.txt',
  'lppl1.2': 'https://www.latex-project.org/lppl/lppl-1-2.txt',
  'lppl1.3': 'https://www.latex-project.org/lppl/lppl-1-3c.txt',
  'lppl1.3a': 'https://www.latex-project.org/lppl/lppl-1-3a.txt',
  'lppl1.3b': 'https://www.latex-project.org/lppl/lppl-1-3c.txt',
  'lppl1.3c': 'https://www.latex-project.org/lppl/lppl-1-3c.txt',
  gpl: 'https://www.gnu.org/licenses/gpl-3.0.html',
  gpl1: 'https://www.gnu.org/licenses/old-licenses/gpl-1.0.html',
  gpl2: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
  gpl3: 'https://www.gnu.org/licenses/gpl-3.0.html',
  'gpl3+': 'https://www.gnu.org/licenses/gpl-3.0.html',
  lgpl2: 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html',
  lgpl3: 'https://www.gnu.org/licenses/lgpl-3.0.html',
  mit: 'https://opensource.org/license/mit',
  bsd: 'https://opensource.org/license/bsd-3-clause',
  bsd2: 'https://opensource.org/license/bsd-2-clause',
  bsd3: 'https://opensource.org/license/bsd-3-clause',
  bsd4: 'https://spdx.org/licenses/BSD-4-Clause.html',
  apache2: 'https://www.apache.org/licenses/LICENSE-2.0',
  ofl: 'https://openfontlicense.org/',
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'cc-by-3': 'https://creativecommons.org/licenses/by/3.0/',
  'cc-by-4': 'https://creativecommons.org/licenses/by/4.0/',
  'cc-by-sa-3': 'https://creativecommons.org/licenses/by-sa/3.0/',
  'cc-by-sa-4': 'https://creativecommons.org/licenses/by-sa/4.0/',
  pd: 'https://creativecommons.org/publicdomain/mark/1.0/',
  knuth: 'https://ctan.org/license/knuth',
};

const LICENSE_NAMES: Record<string, string> = {
  pd: 'Public domain',
  knuth: 'Knuth license',
  noinfo: 'License not stated',
  'other-free': 'Free (see the package)',
  nosell: 'Free, no selling',
  nocommercial: 'Non-commercial',
};

/**
 * Own-property lookup. Every key here comes from the compiler over HTTP, and a
 * bare index read answers 'constructor' or 'toString' with something from
 * Object.prototype instead of undefined.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function licenseLabel(id: string): string {
  const named = own(LICENSE_NAMES, id);
  if (named) return named;
  const lppl = id.match(/^lppl([\d.a-z]*)$/);
  if (lppl) return `LPPL${lppl[1] ? ` ${lppl[1]}` : ''}`;
  const gpl = id.match(/^(l?gpl)([\d.+]*)$/);
  if (gpl) return `${gpl[1].toUpperCase()}${gpl[2] ? ` ${gpl[2]}` : ''}`;
  const cc = id.match(/^cc-(by(?:-sa|-nc|-nd)*)-(\d)$/);
  if (cc) return `CC ${cc[1].toUpperCase().replace(/-/g, '-')} ${cc[2]}.0`;
  if (id === 'cc0') return 'CC0';
  if (id === 'mit') return 'MIT';
  if (/^bsd/.test(id)) return id.toUpperCase().replace('BSD', 'BSD ');
  if (id === 'apache2') return 'Apache 2.0';
  if (id === 'ofl') return 'SIL OFL';
  return id;
}

const CACHE_OK_MS = 10 * 60_000;
const CACHE_FAIL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
/**
 * How long a template listing waits for a catalog that is not cached yet. A
 * compiler that is reachable but silent must not hold GET /api/templates open:
 * the gallery answers with the folder templates and the venue half appears once
 * the fetch lands in the cache.
 */
export const CATALOG_WAIT_MS = 2_000;

let cache: { at: number; ttl: number; classes: CatalogClass[] } | null = null;
let inflight: Promise<CatalogClass[]> | null = null;
/** Bumped by resetVenueCache so an orphaned fetch cannot write over the new state. */
let generation = 0;

/**
 * The last catalog the compiler actually answered with, however stale. A
 * failed fetch keeps these rows under its short TTL rather than replacing
 * them with an empty list: a tile the gallery showed a moment ago must not
 * turn into "unknown template" at create time because the compiler blinked.
 */
function lastGoodClasses(): CatalogClass[] {
  return cache ? cache.classes : [];
}

/**
 * The compiler's class list, cached. Any failure is an empty list, never a
 * throw, and no caller waits longer than waitMs for a cold catalog: past that
 * the answer is the last catalog the compiler gave, so a TTL rollover keeps
 * serving the venues instead of dropping them for one request.
 */
export async function venueClasses(waitMs = FETCH_TIMEOUT_MS): Promise<CatalogClass[]> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.classes;
  const pending = inflight ?? (inflight = fetchClasses());
  if (waitMs >= FETCH_TIMEOUT_MS) return pending;
  return new Promise<CatalogClass[]>((resolve) => {
    const timer = setTimeout(() => resolve(lastGoodClasses()), waitMs);
    // The fetch keeps running into the cache; this caller just stops waiting.
    pending.then((classes) => { clearTimeout(timer); resolve(classes); }, () => { clearTimeout(timer); resolve(lastGoodClasses()); });
  });
}

function fetchClasses(): Promise<CatalogClass[]> {
  const gen = generation;
  return (async () => {
    try {
      const res = await fetch(`${config.compilerUrl}/catalog`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; classes?: CatalogClass[] };
      // ok:false is a probe that did not run (kpsewhich missing or timed out),
      // not an installation with no classes.
      if (body.ok === false) throw new Error('catalog probe failed');
      const classes = Array.isArray(body.classes) ? body.classes.filter((c) => c && typeof c.id === 'string' && typeof c.cls === 'string') : [];
      if (gen === generation) cache = { at: Date.now(), ttl: CACHE_OK_MS, classes };
      return classes;
    } catch {
      // A compiler that is still booting must not poison the cache for long,
      // and one that answered before keeps its answer on the books meanwhile.
      const kept = lastGoodClasses();
      if (gen === generation) cache = { at: Date.now(), ttl: CACHE_FAIL_MS, classes: kept };
      return kept;
    } finally {
      if (gen === generation) inflight = null;
    }
  })();
}

/** Fills the cache at boot so the first listing does not pay for the fetch. */
export function warmVenueCache(): void {
  void venueClasses().catch(() => undefined);
}

/** Drops the cache; the next listing re-asks the compiler. */
export function resetVenueCache(): void {
  cache = null;
  inflight = null;
  generation++;
}

export function venueTemplateInfo(c: CatalogClass): TemplateInfo | null {
  const meta = own(INSTALLED_VENUES, c.id);
  if (!meta) return null;
  const info: TemplateInfo = {
    id: VENUE_PREFIX + c.id,
    name: meta.name,
    description: `${meta.description} Uses the ${c.cls} ${c.kind === 'style' ? 'style' : 'class'} installed in the compiler image.`,
    icon: meta.icon || '📄',
    category: meta.category,
    documentClass: c.cls,
  };
  if (c.license) {
    info.license = licenseLabel(c.license);
    const url = own(LICENSE_URLS, c.license);
    if (url) info.licenseUrl = url;
  }
  if (c.source || c.version) {
    info.source = { url: c.source || `https://ctan.org/pkg/${c.pkg || c.id}`, version: c.version || undefined };
  }
  return info;
}

/** Every installed venue as a template, alphabetical inside its category. */
export async function venueTemplates(waitMs?: number): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = [];
  for (const c of await venueClasses(waitMs)) {
    const info = venueTemplateInfo(c);
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const REFERENCES_BIB = `@article{knuth1984,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  year    = {1984},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
}
`;

/**
 * A compilable starting point for a class the image has but ships no sample for.
 * Deliberately generic: the venue's own author guide is the authority on the
 * options, and the tile links to it.
 */
export function skeleton(c: CatalogClass, meta: VenueMeta): string {
  const head0 = c.kind === 'style'
    ? `\\documentclass{article}\n\\usepackage{${c.cls}}\n`
    : `\\documentclass${meta.options ? `[${meta.options}]` : ''}{${c.cls}}\n`;
  const packages = (meta.packages || []).map((p) => `\\usepackage{${p}}\n`).join('');
  const head = head0 + packages;
  const bib = meta.biblatexStyle
    ? { pre: `\\usepackage[style=${meta.biblatexStyle},backend=biber]{biblatex}\n\\addbibresource{references.bib}\n`, post: '\\printbibliography\n' }
    : meta.classSetsBibStyle
      ? { pre: '', post: '\\bibliography{references}\n' }
      : { pre: '', post: `\\bibliographystyle{${meta.bibStyle || 'plain'}}\n\\bibliography{references}\n` };
  const body = `\\section{Introduction}\nState the problem and why it matters. Cite prior work like this~\\cite{knuth1984}.\n\n`;
  const abstract = '\\begin{abstract}\nA one-paragraph summary of the problem, your approach, and the headline result.\n\\end{abstract}\n\n';
  const notice = `% ${meta.name} starting point, generated by Aldine from the ${c.cls} `
    + `${c.kind === 'style' ? 'style' : 'class'} installed in the compiler image.\n`
    + `% Check the venue's author guide for the options and sections it requires.\n`;
  const tail = body + bib.post + '\n\\end{document}\n';

  if (meta.front === 'frontmatter') {
    return notice + head + bib.pre
      + '\n\\begin{document}\n\n\\begin{frontmatter}\n\n'
      + '\\title{Your title here}\n\n'
      + '\\author[inst1]{Your Name}\n'
      + '\\affiliation[inst1]{organization={Your institution}, country={Your country}}\n\n'
      + abstract
      + '\\begin{keyword}\nfirst keyword \\sep second keyword\n\\end{keyword}\n\n'
      + '\\end{frontmatter}\n\n'
      + tail;
  }
  if (meta.front === 'inbody') {
    return notice + head + bib.pre
      + '\n\\begin{document}\n\n'
      + '\\title{Your title here}\n\n'
      + '\\author{Your Name}\n'
      + '\\affiliation{Your institution}\n\n'
      + abstract
      + '\\maketitle\n\n'
      + tail;
  }
  if (meta.front === 'acm') {
    // acmart refuses an author without an institution and a country.
    return notice + head + bib.pre
      + '\n\\begin{document}\n\n'
      + '\\title{Your title here}\n\n'
      + '\\author{Your Name}\n'
      + '\\affiliation{\n  \\institution{Your institution}\n  \\city{Your city}\n  \\country{Your country}\n}\n'
      + '\\email{you@example.org}\n\n'
      + abstract
      + '\\maketitle\n\n'
      + tail;
  }
  if (meta.front === 'abstract-first') {
    return notice + head + bib.pre
      + '\n\\title{Your title here}\n\\author{Your Name}\n\\date{\\today}\n'
      + '\n\\begin{document}\n\n'
      + abstract
      + '\\maketitle\n\n'
      + tail;
  }
  return notice + head + bib.pre
    + '\n\\title{Your title here}\n\\author{Your Name}\n\\date{\\today}\n'
    + '\n\\begin{document}\n\\maketitle\n\n'
    + abstract
    + tail;
}

/**
 * Only main.tex and references.bib are seeded, so a sample document that pulls
 * in a sibling (a body fragment, a teaser figure, the package's own .bib) would
 * fail on the project's first compile. The compiler filters these out too; this
 * is the trust boundary, and the generated skeleton is the fallback.
 */
const SIBLING_MACROS = /\\(input|include|includegraphics|subfile|lstinputlisting|verbatiminput)\s*[{[]/;

export function sampleIsSelfContained(content: string): boolean {
  // Comments are not compiled, and samples routinely park an \includegraphics
  // example behind a %.
  const src = content.replace(/(^|[^\\])%.*$/gm, '$1');
  if (SIBLING_MACROS.test(src)) return false;
  for (const m of src.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim().replace(/\.bib$/i, '');
      if (n && n !== 'references') return false;
    }
  }
  return true;
}

/**
 * Seed files for a venue template id (`venue:<id>`): the class's own sample
 * document when the image ships one, otherwise the generated skeleton.
 */
export async function venueTemplateFiles(id: string): Promise<Record<string, Buffer>> {
  const key = id.slice(VENUE_PREFIX.length);
  const meta = own(INSTALLED_VENUES, key);
  // Resolve against the same list the gallery was served from (CATALOG_WAIT_MS,
  // last-good on a slow or failing compiler): a tile the user can see must not
  // 400 because the catalog fetch happened to fail between listing and create.
  const cls = (await venueClasses(CATALOG_WAIT_MS)).find((c) => c.id === key);
  if (!meta || !cls) throw new Error(`unknown template: ${id}`);
  const sample = cls.sample?.content;
  const main = sample && sampleIsSelfContained(sample) ? sample : skeleton(cls, meta);
  return {
    'main.tex': Buffer.from(main, 'utf8'),
    'references.bib': Buffer.from(REFERENCES_BIB, 'utf8'),
  };
}
