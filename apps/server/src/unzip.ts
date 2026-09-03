import zlib from 'node:zlib';

/**
 * Minimal ZIP reader (store + deflate) — enough for Overleaf/project exports.
 * Parses the End-of-Central-Directory + central directory, then local headers.
 * Returns { path -> Buffer } for files (directories skipped).
 */
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;   // 40 MB per file
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;  // 200 MB inflated total

export function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let total = 0;
  // find End of Central Directory (0x06054b50), scanning from the end
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central dir header
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory
    // read the local header to find the actual data start
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES });
    else continue; // unsupported method
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('archive expands too large');
    out[name] = data;
  }
  return out;
}

/** \documentclass or \begin{document} outside a `%` comment — a commented-out
 *  preamble in a snippet must not make it a root candidate. */
const HAS_DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;
const HAS_BEGIN_DOCUMENT = /^[^%\n]*\\begin\{document\}/m;
// Journal templates open with comment banners well past 4 KB; scanning this
// much of each .tex keeps the cost bounded on a 200 MB archive.
const ROOT_SCAN_BYTES = 256 * 1024;
const ROOT_NAMES = /^(main|paper|manuscript|ms|article|thesis)$/i;

/**
 * Pick the root .tex of an imported archive. Candidates carry \documentclass;
 * among them prefer \begin{document} (a template's class stub has none), then
 * a conventional root name, then the shallowest path, then the smallest file
 * (a bundled sample/template outsizes the manuscript). Without any candidate,
 * the shallowest .tex — never a name that is not in the archive.
 */
export function guessRoot(files: Record<string, Buffer>): string | undefined {
  type Ranked = { path: string; key: number[] };
  const depth = (p: string) => p.split('/').length;
  const named = (p: string) => (ROOT_NAMES.test(p.split('/').pop()!.replace(/\.tex$/i, '')) ? 0 : 1);
  const before = (a: Ranked, b: Ranked) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i];
    return a.path < b.path;
  };
  let best: Ranked | null = null;
  let fallback: Ranked | null = null;
  for (const [path, data] of Object.entries(files)) {
    if (!/\.tex$/i.test(path)) continue;
    const shallow: Ranked = { path, key: [depth(path), named(path), data.length] };
    if (!fallback || before(shallow, fallback)) fallback = shallow;
    const head = data.toString('utf8', 0, Math.min(data.length, ROOT_SCAN_BYTES));
    if (!HAS_DOCUMENTCLASS.test(head)) continue;
    const ranked: Ranked = { path, key: [HAS_BEGIN_DOCUMENT.test(head) ? 0 : 1, named(path), depth(path), data.length] };
    if (!best || before(ranked, best)) best = ranked;
  }
  return (best ?? fallback)?.path;
}
