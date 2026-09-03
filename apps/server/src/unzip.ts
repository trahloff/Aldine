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
