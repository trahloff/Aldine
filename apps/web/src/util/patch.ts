import { diffWords, type Segment } from './wordDiff';

/** Distinct file paths touched by a unified git patch (diff --git headers). */
export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const i = line.lastIndexOf(' b/');
    if (i !== -1) files.add(line.slice(i + 3));
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
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      out.push({ kind: 'file', text: m ? (m[1] === m[2] ? m[1] : `${m[1]} → ${m[2]}`) : l });
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
