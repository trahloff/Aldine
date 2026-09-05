import zlib from 'node:zlib';

/**
 * Minimal ZIP reader (store + deflate, ZIP64) for Overleaf/project exports.
 * Parses the End-of-Central-Directory (and its ZIP64 record), the central
 * directory, then each local header. Returns { path -> Buffer } for files
 * (directories skipped). Anything it cannot read is an error that names the
 * entry and the reason; no entry is ever dropped silently.
 */
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;   // 40 MB per file
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;  // 200 MB inflated total
// Every entry costs a synchronous write and a git add, whatever its size;
// with ZIP64 the directory can declare millions of empty ones inside the
// upload limit. A real project has hundreds of files, a large one thousands.
const MAX_ENTRIES = 20_000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

/** APPNOTE 4.4.5 method ids; anything not listed is reported by number. */
const METHOD_NAMES: Record<number, string> = {
  1: 'shrink', 2: 'reduce', 3: 'reduce', 4: 'reduce', 5: 'reduce', 6: 'implode', 7: 'tokenize',
  9: 'deflate64', 10: 'PKWARE DCL implode', 12: 'bzip2', 14: 'LZMA', 16: 'IBM z/OS CMPSC',
  18: 'IBM TERSE', 19: 'IBM LZ77', 20: 'zstd', 93: 'zstd', 94: 'MP3', 95: 'xz', 96: 'JPEG',
  97: 'WavPack', 98: 'PPMd',
};

/** cp437 (the original PC OEM set) for bytes 0x80..0xFF; 0x00..0x7F are ASCII. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export class ZipError extends Error {
  /** Entry count from the end-of-central-directory record, when it was readable. */
  entryCount?: number;
  constructor(message: string, entryCount?: number) {
    super(message);
    this.name = 'ZipError';
    this.entryCount = entryCount;
  }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * Entry names carry no encoding unless flag bit 11 says UTF-8. Info-ZIP on
 * Linux/macOS writes UTF-8 without the bit, so valid UTF-8 wins; the
 * Info-ZIP Unicode Path extra (0x7075) is trusted when its CRC matches; what
 * is left is a legacy codepage: cp437 (Windows' OEM default, 7-Zip, older
 * WinZip) unless every high byte lands in cp437's box-drawing/Greek range,
 * where a Latin-1 reading (umlauts, accents) is the plausible one.
 */
function decodeName(raw: Buffer, flags: number, extra: Buffer): string {
  if (flags & FLAG_UTF8) return raw.toString('utf8');
  const unicodePath = findExtra(extra, 0x7075);
  if (unicodePath && unicodePath.length >= 5 && unicodePath[0] === 1 && unicodePath.readUInt32LE(1) === zlib.crc32(raw)) {
    try { return utf8Strict.decode(unicodePath.subarray(5)); } catch { /* fall through */ }
  }
  try { return utf8Strict.decode(raw); } catch { /* legacy codepage */ }
  let cp437 = false;
  for (const b of raw) if (b >= 0x80 && b < 0xb0) { cp437 = true; break; }
  if (!cp437) return raw.toString('latin1');
  let out = '';
  for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

function findExtra(extra: Buffer, id: number): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const fid = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (fid === id) return extra.subarray(p + 4, Math.min(p + 4 + size, extra.length));
    p += 4 + size;
  }
  return null;
}

function u64(buf: Buffer, off: number, what: string): number {
  if (off + 8 > buf.length) throw new ZipError(`${what} runs past the end of the archive`);
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(`${what} is larger than this server can address`);
  return Number(v);
}

interface Directory { count: number; offset: number }

/** EOCD, then the ZIP64 record via its locator when the archive has one. */
function readDirectory(buf: Buffer): Directory {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a zip file');
  let count: number = buf.readUInt16LE(eocd + 10);
  let offset: number = buf.readUInt32LE(eocd + 16);
  const needZip64 = count === 0xffff || offset === 0xffffffff;
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === SIG_ZIP64_LOCATOR) {
    const recOff = u64(buf, loc + 8, 'the ZIP64 directory offset');
    if (recOff + 56 > buf.length || buf.readUInt32LE(recOff) !== SIG_ZIP64_EOCD) {
      throw new ZipError('the ZIP64 end of central directory record is missing or damaged');
    }
    count = u64(buf, recOff + 32, 'the ZIP64 entry count');
    offset = u64(buf, recOff + 48, 'the ZIP64 directory offset');
  } else if (needZip64) {
    throw new ZipError('the archive needs ZIP64 but has no ZIP64 locator');
  }
  if (offset >= buf.length) throw new ZipError('the central directory offset is past the end of the archive');
  return { count, offset };
}

/** Entry count from the directory record alone; null when there is none. */
export function zipEntryCount(buf: Buffer): number | null {
  try { return readDirectory(buf).count; } catch { return null; }
}

export function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let total = 0;
  const { count, offset } = readDirectory(buf);
  const fail = (msg: string) => new ZipError(msg, count);
  if (count > MAX_ENTRIES) throw fail(`the archive has ${count} entries; the limit is ${MAX_ENTRIES}`);
  let off = offset;

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw fail(`the central directory is damaged (entry ${n + 1} of ${count} is missing)`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    let compSize: number = buf.readUInt32LE(off + 20);
    let uncompSize: number = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    let localOff: number = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nameLen);
    const extra = buf.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
    const name = decodeName(rawName, flags, extra);
    off += 46 + nameLen + extraLen + commentLen;

    // ZIP64 extra: 64-bit values, in this order, only for the fields the
    // 32-bit header saturated.
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
      const z = findExtra(extra, 0x0001);
      if (!z) throw fail(`entry "${name}" has ZIP64 sizes but no ZIP64 extra field`);
      let p = 0;
      const next = (what: string) => { const v = u64(z, p, `${what} of "${name}"`); p += 8; return v; };
      if (uncompSize === 0xffffffff) uncompSize = next('the size');
      if (compSize === 0xffffffff) compSize = next('the compressed size');
      if (localOff === 0xffffffff) localOff = next('the offset');
    }

    if (name.endsWith('/')) continue; // directory
    if (flags & FLAG_ENCRYPTED || method === METHOD_AES) {
      const scheme = method === METHOD_AES ? 'AES' : 'ZipCrypto';
      throw fail(`entry "${name}" is password protected (${scheme}); remove the password and export the archive again`);
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      const label = METHOD_NAMES[method] ? `${METHOD_NAMES[method]} compression (method ${method})` : `compression method ${method}`;
      throw fail(`entry "${name}" uses ${label}; only store and deflate are supported, so re-zip the files with standard compression`);
    }
    // A stored entry is bounded by the archive itself; only inflation can
    // outgrow it, so the per-file cap applies to deflate.
    if (method === METHOD_DEFLATE && uncompSize > MAX_ENTRY_BYTES) {
      throw fail(`entry "${name}" is ${Math.round(uncompSize / 1024 / 1024)} MB unpacked; the limit per file is ${MAX_ENTRY_BYTES / 1024 / 1024} MB`);
    }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) {
      throw fail(`the local header of entry "${name}" is missing`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw fail(`entry "${name}" runs past the end of the archive`);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === METHOD_STORE) data = comp;
    else {
      try { data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES }); }
      catch (err: any) {
        throw fail(err?.code === 'ERR_BUFFER_TOO_LARGE'
          ? `entry "${name}" unpacks past the ${MAX_ENTRY_BYTES / 1024 / 1024} MB limit per file`
          : `entry "${name}" has damaged deflate data`);
      }
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw fail(`the archive unpacks past the ${MAX_TOTAL_BYTES / 1024 / 1024} MB total limit`);
    out[name] = data;
  }
  return out;
}
