/**
 * Build a ZIP from { name -> Buffer|string|entry } for tests. Entry names are
 * written verbatim, so a test can put `../x` or `a\b` in an archive the way a
 * hostile or Windows-made zip would. An entry object can set:
 *   data      Buffer|string (default '')
 *   method    0 store (default), 8 deflate (compressed here), anything else
 *             is written as-is with that method id (bzip2, lzma, AES 99...)
 *   flags     general-purpose bits (0x1 encrypted, 0x800 UTF-8 name)
 *   nameBytes raw name bytes instead of UTF-8 of the key (cp437/latin-1 names)
 *   extra     extra field bytes for the central directory header
 * Options: { zip64: true } writes 0xFFFFFFFF sentinels, ZIP64 extra fields,
 * the ZIP64 end-of-central-directory record and its locator, the way an
 * archiver does for archives past 4 GB or 65 535 entries.
 */
import zlib from 'node:zlib';

const FFFF = 0xffffffff;

export function buildZip(entries, opts = {}) {
  const zip64 = !!opts.zip64;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [key, spec] of Object.entries(entries)) {
    const e = Buffer.isBuffer(spec) || typeof spec === 'string' ? { data: spec } : spec;
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const method = e.method ?? 0;
    const flags = e.flags ?? 0;
    const nameBuf = e.nameBytes ?? Buffer.from(key, 'utf8');
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const localExtra = zip64 ? zip64Extra([data.length, comp.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? FFFF : comp.length, 18);
    local.writeUInt32LE(zip64 ? FFFF : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const centralExtra = Buffer.concat([zip64 ? zip64Extra([data.length, comp.length, offset]) : Buffer.alloc(0), e.extra ?? Buffer.alloc(0)]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? FFFF : comp.length, 20);
    central.writeUInt32LE(zip64 ? FFFF : data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(zip64 ? FFFF : offset, 42);
    locals.push(local, nameBuf, localExtra, comp);
    centrals.push(central, nameBuf, centralExtra);
    offset += local.length + nameBuf.length + localExtra.length + comp.length;
  }
  const count = Object.keys(entries).length;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(zip64 ? FFFF : cdSize, 12);
  eocd.writeUInt32LE(zip64 ? FFFF : offset, 16);
  return Buffer.concat([...locals, ...centrals, ...tail, eocd]);
}

function zip64Extra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

/** Info-ZIP Unicode Path extra field (0x7075) naming `utf8Name` for `rawName`. */
export function unicodePathExtra(rawName, utf8Name) {
  const name = Buffer.from(utf8Name, 'utf8');
  const b = Buffer.alloc(4 + 5 + name.length);
  b.writeUInt16LE(0x7075, 0);
  b.writeUInt16LE(5 + name.length, 2);
  b.writeUInt8(1, 4);
  b.writeUInt32LE(zlib.crc32(rawName), 5);
  name.copy(b, 9);
  return b;
}
