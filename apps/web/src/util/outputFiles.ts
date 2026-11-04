/** A file the typeset wrote beside its PDF, served by the same output route. */
export interface OutputFile { name: string; url: string }

/** Only the path and query are read and written: the links stay relative,
 *  under whatever base path the app is served from. */
const parse = (url: string) => new URL(url, 'http://output.invalid');

/** The file an output-route link serves (`main.pdf`), null when it names none. */
export function outputFileName(url: string): string | null {
  const path = parse(url).searchParams.get('path');
  return path ? path.slice(path.lastIndexOf('/') + 1) || null : null;
}

/**
 * The link to the file with extension `ext` (`.bbl`, `.log`) that the typeset
 * of `pdfUrl` wrote beside it, through the same route. TeX names them after
 * the root file, as arXiv expects of a .bbl. The PDF's cache-busting `t`
 * names that PDF's run only, so it is dropped.
 */
export function outputSibling(pdfUrl: string, ext: string): OutputFile | null {
  const u = parse(pdfUrl);
  const path = u.searchParams.get('path');
  if (!path || !/\.pdf$/i.test(path)) return null;
  const sibling = path.replace(/\.pdf$/i, ext);
  u.searchParams.set('path', sibling);
  u.searchParams.delete('t');
  return { name: sibling.slice(sibling.lastIndexOf('/') + 1), url: u.pathname + u.search };
}
