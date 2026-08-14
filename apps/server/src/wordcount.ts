/**
 * Whole-document word count: the include graph from the root file, counted
 * with the same approximation the editor status bar uses (client mirror in
 * CodePane.tsx latexWordCount — keep the two regex chains identical).
 */

export function latexWordCount(src: string): number {
  const stripped = src
    .replace(/(^|[^\\])%.*$/gm, '$1')            // comments
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' EQN ') // math counts as one word
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])*/g, ' ')   // commands (keep brace contents)
    .replace(/[{}~]/g, ' ');
  const words = stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
  return words ? words.length : 0;
}

/** Collapse ./ and ../ segments the way TeX path resolution would. */
function joinPath(dir: string, p: string): string {
  const parts = (dir ? dir + '/' + p : p).split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Project-relative paths of every file the document pulls in via
 * \input/\include, root file first, cycle-safe. Targets resolve against the
 * root file's dir (the compile cwd under latexmk -cd), with or without the
 * .tex extension. `read` returns null for files that don't exist — those are
 * skipped, matching a compile where the missing include errors out.
 */
export function documentFiles(rootFile: string, read: (path: string) => string | null): string[] {
  const rootDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : '';
  const seen = new Set<string>([rootFile]);
  const out: string[] = [];
  const queue = [rootFile];
  const INCLUDE_RE = /\\(?:input|include)\{([^}]+)\}/g;
  while (queue.length) {
    const file = queue.shift()!;
    const src = read(file);
    if (src == null) continue;
    out.push(file);
    // strip comments first so a commented-out \input doesn't count
    const active = src.replace(/(^|[^\\])%.*$/gm, '$1');
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(active))) {
      const raw = m[1].trim();
      if (!raw || raw.includes('\\')) continue; // macro in the argument — not resolvable statically
      const target = joinPath(rootDir, /\.[a-z0-9]+$/i.test(raw) ? raw : `${raw}.tex`);
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return out;
}
