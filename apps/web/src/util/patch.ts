import { diffWords, type Segment } from './wordDiff';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

/** Decode one git C-quoted path token (`"..."` with `\"`, `\\`, `\t`,
 *  `\n` and octal bytes) to its UTF-8 text. */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 1; i < quoted.length - 1; i++) {
    const c = quoted[i];
    if (c !== '\\') {
      const code = c.charCodeAt(0);
      if (code < 128) bytes.push(code);
      else bytes.push(...utf8Encoder.encode(c));
      continue;
    }
    const e = quoted[++i];
    switch (e) {
      case 'n': bytes.push(0x0a); break;
      case 't': bytes.push(0x09); break;
      case 'a': bytes.push(0x07); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'v': bytes.push(0x0b); break;
      case 'r': bytes.push(0x0d); break;
      case '\\': bytes.push(0x5c); break;
      case '"': bytes.push(0x22); break;
      default:
        if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && i + 1 < quoted.length - 1 && quoted[i + 1] >= '0' && quoted[i + 1] <= '7') oct += quoted[++i];
          bytes.push(parseInt(oct, 8));
        } else {
          // Unknown escape: keep the escaped character as-is.
          bytes.push(e.charCodeAt(0));
        }
    }
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

/** Parse a `diff --git` header into the [old, new] paths it names. Git
 *  C-quotes a side whose bytes are not plain ASCII (a non-ASCII name, a
 *  space, a `"`), so each side is either a bare token or a `"..."` string
 *  with C-style escapes; octal bytes decode as UTF-8. Returns null when
 *  the line is not a well-formed header. */
export function parseDiffGitHeader(line: string): [string, string] | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  const tokens: string[] = [];
  let i = 0;
  while (tokens.length < 2) {
    while (rest[i] === ' ') i++;
    if (i >= rest.length) return null;
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '"') {
        if (rest[j] === '\\') j++;
        j++;
      }
      if (j >= rest.length) return null;
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = rest.indexOf(' ', i);
      if (j === -1) j = rest.length;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  if (rest.slice(i).trim() !== '') return null;
  const paths = tokens.map((t) => (t.startsWith('"') ? unquoteGitPath(t) : t));
  if (!paths[0].startsWith('a/') || !paths[1].startsWith('b/')) return null;
  return [paths[0].slice(2), paths[1].slice(2)];
}

/** Distinct file paths touched by a unified git patch (diff --git headers). */
export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const header = parseDiffGitHeader(line);
    if (header) files.add(header[1]);
  }
  return [...files];
}

export type PatchLine =
  | { kind: 'file' | 'hunk' | 'ctx'; text: string }
  | { kind: 'add' | 'del'; text: string; words?: Segment[] };

/** The patch as rows. Git's header lines between `diff --git` and the first
 *  hunk are dropped, and only there: a removed line that reads "-- x" is
 *  content, not a `---` header. A run of removed lines followed by added
 *  ones is an edit; its lines pair up in order for word highlights. */
export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let header = false;
  let dels: number[] = [];
  let adds: number[] = [];
  const pair = () => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = out[dels[k]] as Extract<PatchLine, { kind: 'add' | 'del' }>;
      const a = out[adds[k]] as Extract<PatchLine, { kind: 'add' | 'del' }>;
      const w = diffWords(d.text.slice(1), a.text.slice(1));
      if (w) { d.words = w.del; a.words = w.add; }
    }
    dels = [];
    adds = [];
  };
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git')) {
      pair();
      header = true;
      const m = parseDiffGitHeader(l);
      out.push({ kind: 'file', text: m ? (m[0] === m[1] ? m[0] : `${m[0]} → ${m[1]}`) : l });
      continue;
    }
    if (l.startsWith('@@')) {
      pair();
      header = false;
      out.push({ kind: 'hunk', text: l });
      continue;
    }
    if (header) {
      // "Binary files a/x and b/x differ" is all a binary change says
      if (/^Binary files /.test(l)) out.push({ kind: 'ctx', text: l });
      continue;
    }
    if (l.startsWith('-')) {
      if (adds.length) pair();
      dels.push(out.length);
      out.push({ kind: 'del', text: l });
    } else if (l.startsWith('+')) {
      adds.push(out.length);
      out.push({ kind: 'add', text: l });
    } else if (l.startsWith('\\')) {
      // "\ No newline at end of file" sits inside the edit it annotates
      out.push({ kind: 'ctx', text: l });
    } else {
      pair();
      out.push({ kind: 'ctx', text: l || ' ' });
    }
  }
  pair();
  return out;
}
