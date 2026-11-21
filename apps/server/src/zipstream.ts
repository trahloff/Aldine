import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';

/**
 * A ZIP written as it goes, for downloads too large to hold in memory: each
 * entry is a Buffer the caller has in hand (so its CRC and size go into the
 * local header and no data descriptor is needed), and only the central
 * directory waits for the end. Entries are stored, not deflated: what goes
 * in here is already compressed (project ZIPs, pictures) or small (JSON).
 * ZIP64 records are written once offsets or the entry count pass what the
 * classic format holds; a single entry stays below 4 GiB.
 */

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Unix regular file, rw-r--r--, in the high half of the external attributes. */
const FILE_ATTRS = (0o100644 << 16) >>> 0;
/** Version made by: Unix (3), spec 4.5. */
const MADE_BY = (3 << 8) | 45;

interface Written { name: Buffer; crc: number; size: number; offset: number; time: number; date: number }

/** DOS time and date fields of `d`, which hold local wall-clock time. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipStream {
  /** What the reader consumes: the response body. */
  readonly stream = new PassThrough();
  private offset = 0;
  private entries: Written[] = [];
  private names = new Set<string>();

  /** The reader went away (the download was cancelled). */
  get closed(): boolean { return this.stream.destroyed; }

  private async write(buf: Buffer): Promise<void> {
    if (this.stream.destroyed) throw new Error('the download was closed');
    this.offset += buf.length;
    if (this.stream.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { this.stream.off('close', gone); resolve(); };
      const gone = () => { this.stream.off('drain', done); reject(new Error('the download was closed')); };
      this.stream.once('drain', done);
      this.stream.once('close', gone);
    });
  }

  /** Add one file. `name` uses forward slashes and is unique in the archive. */
  async add(name: string, data: Buffer, mtime = new Date()): Promise<void> {
    if (!name || name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '')) throw new Error(`bad entry name ${JSON.stringify(name)}`);
    if (this.names.has(name)) throw new Error(`duplicate entry ${JSON.stringify(name)}`);
    if (data.length >= MAX32) throw new Error(`${name} is too large for one ZIP entry`);
    this.names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const { time, date } = dosDateTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.entries.push({ name: nameBuf, crc, size: data.length, offset: this.offset, time, date });
    await this.write(Buffer.concat([local, nameBuf]));
    if (data.length) await this.write(data);
  }

  /** Write the central directory and end the stream. */
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = e.offset >= MAX32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
      }
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(MADE_BY, 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attributes
      h.writeUInt32LE(FILE_ATTRS, 38);
      h.writeUInt32LE(big ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const recordAt = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(MADE_BY, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(recordAt), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64 ? MAX16 : count, 8);
    end.writeUInt16LE(zip64 ? MAX16 : count, 10);
    end.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? MAX32 : cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.stream.end();
  }
}
