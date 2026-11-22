'use strict';
/**
 * The wire format between the app and the runner, and between the runner
 * and its helpers: a stream of frames, each [type u8][length u32 BE][payload].
 *
 *   HEADER (1)  JSON
 *   FILE   (2)  [path length u16 BE][path UTF-8][content]
 *   SKIP   (3)  JSON { path, reason }
 *   END    (0)  empty
 *
 * Every reader is bounded: a frame longer than maxFrame, or more than
 * maxTotal bytes in all, is an error before the bytes are kept.
 */
const HEADER = 1;
const FILE = 2;
const SKIP = 3;
const END = 0;

function frame(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const header = (obj) => frame(HEADER, Buffer.from(JSON.stringify(obj)));
const skip = (path, reason) => frame(SKIP, Buffer.from(JSON.stringify({ path, reason })));
const end = () => frame(END);

function file(path, content) {
  const p = Buffer.from(path, 'utf8');
  if (p.length > 0xffff) throw new Error('path too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(p.length, 0);
  return frame(FILE, Buffer.concat([len, p, content]));
}

/** Splits incoming bytes into frames. push() returns the complete frames so
 *  far as { type, payload }; FILE frames come back as { type, path, content }.
 *  Linear in the bytes read: a chunk is copied once, when its frame is whole. */
class Reader {
  constructor({ maxFrame, maxTotal }) {
    this.maxFrame = maxFrame;
    this.maxTotal = maxTotal;
    this.total = 0;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
  }

  /** Removes and returns the first n buffered bytes. */
  take(n) {
    const parts = [];
    let need = n;
    while (need > 0) {
      const c = this.chunks[0];
      if (c.length <= need) { parts.push(c); this.chunks.shift(); need -= c.length; } else {
        parts.push(c.subarray(0, need));
        this.chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    this.buffered -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  /** The first 5 bytes, without removing them. */
  peekHead() {
    if (this.chunks[0].length >= 5) return this.chunks[0];
    return Buffer.concat(this.chunks, Math.min(this.buffered, 5));
  }

  push(chunk) {
    this.total += chunk.length;
    if (this.total > this.maxTotal) throw new Error(`more than ${this.maxTotal} bytes`);
    if (chunk.length) { this.chunks.push(chunk); this.buffered += chunk.length; }
    const out = [];
    while (!this.ended && this.buffered >= 5) {
      const head = this.peekHead();
      const type = head.readUInt8(0);
      const len = head.readUInt32BE(1);
      if (len > this.maxFrame) throw new Error(`a frame of ${len} bytes is over the limit`);
      if (this.buffered < 5 + len) break;
      this.take(5);
      const payload = Buffer.from(this.take(len));
      out.push(decode(type, payload));
      if (type === END) this.ended = true;
    }
    if (this.ended && this.buffered) throw new Error('bytes after the end frame');
    return out;
  }
}

function decode(type, payload) {
  if (type === HEADER || type === SKIP) return { type, value: JSON.parse(payload.toString('utf8')) };
  if (type === FILE) {
    if (payload.length < 2) throw new Error('short file frame');
    const n = payload.readUInt16BE(0);
    if (payload.length < 2 + n) throw new Error('short file frame');
    return { type, path: payload.subarray(2, 2 + n).toString('utf8'), content: payload.subarray(2 + n) };
  }
  if (type === END) {
    if (payload.length) throw new Error('end frame with a payload');
    return { type };
  }
  throw new Error(`unknown frame type ${type}`);
}

module.exports = { HEADER, FILE, SKIP, END, frame, header, file, skip, end, Reader };
