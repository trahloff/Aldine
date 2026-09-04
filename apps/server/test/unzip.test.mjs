/**
 * The ZIP reader on archives the old one misread or skipped silently: ZIP64
 * records and extra fields, deflate, foreign compression methods, encrypted
 * entries, legacy-codepage names, and damaged directories. Every unsupported
 * case is an error that names the entry; nothing is dropped.
 */
import { check, eq, throws } from './assert.mjs';
import { buildZip, unicodePathExtra } from './zip.mjs';

const { unzip, zipEntryCount } = await import('../src/unzip.ts');

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const B = (s) => Buffer.from(s);

// ---- store + deflate, plain archive ----
let files = unzip(buildZip({ 'main.tex': doc, 'big.txt': { data: 'x'.repeat(100_000), method: 8 }, 'figs/': '' }));
eq(Object.keys(files).sort(), ['big.txt', 'main.tex'], 'store and deflate entries read, directory skipped');
eq(files['big.txt'].length, 100_000, 'deflate entry inflated');
eq(zipEntryCount(buildZip({ 'a': '1', 'b': '2', 'c/': '' })), 3, 'entry count from the EOCD');
eq(zipEntryCount(B('not a zip at all')), null, 'no directory: null');

// ---- ZIP64 ----
const z64 = buildZip({ 'paper/main.tex': doc, 'paper/data.csv': { data: '1,2,3\n'.repeat(1000), method: 8 } }, { zip64: true });
check(z64.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'fixture carries a ZIP64 EOCD record');
files = unzip(z64);
eq(Object.keys(files).sort(), ['paper/data.csv', 'paper/main.tex'], 'ZIP64 archive: entries via the ZIP64 record and extra fields');
eq(files['paper/main.tex'].toString(), doc, 'ZIP64 entry bytes intact');
eq(files['paper/data.csv'].length, 6000, 'ZIP64 deflate entry inflated');
eq(zipEntryCount(z64), 2, 'entry count from the ZIP64 record');
const noLocator = buildZip({ 'main.tex': doc });
noLocator.writeUInt16LE(0xffff, noLocator.length - 22 + 10);
await throws(() => unzip(noLocator), 'needs ZIP64 but has no ZIP64 locator', 'saturated count without a locator');
const badLocator = Buffer.from(z64);
badLocator.writeBigUInt64LE(BigInt(badLocator.length + 100), badLocator.length - 22 - 20 + 8);
await throws(() => unzip(badLocator), 'ZIP64 end of central directory record is missing or damaged', 'locator pointing past the archive');

// ---- unsupported methods: named, never skipped ----
await throws(() => unzip(buildZip({ 'main.tex': doc, 'figs/plot.pdf': { data: 'BZh9garbage', method: 12 } })),
  'entry "figs/plot.pdf" uses bzip2 compression (method 12); only store and deflate are supported', 'bzip2 entry');
await throws(() => unzip(buildZip({ 'a.tex': { data: 'x', method: 14 } })), 'uses LZMA compression (method 14)', 'lzma entry');
await throws(() => unzip(buildZip({ 'a.tex': { data: 'x', method: 77 } })), 'uses compression method 77', 'unknown method id is reported by number');
const okThenBad = buildZip({ 'main.tex': doc, 'late.bin': { data: 'x', method: 12 } });
await throws(() => unzip(okThenBad), 'late.bin', 'a bad entry after good ones still fails the archive');

// ---- encrypted entries ----
await throws(() => unzip(buildZip({ 'main.tex': { data: 'garbage', flags: 0x1 } })),
  'entry "main.tex" is password protected (ZipCrypto); remove the password and export the archive again', 'ZipCrypto flag');
await throws(() => unzip(buildZip({ 'main.tex': { data: 'garbage', flags: 0x1, method: 99 } })),
  'entry "main.tex" is password protected (AES)', 'AES method 99');

// ---- names: UTF-8 flag, UTF-8 without the flag, cp437, latin-1, unicode path extra ----
files = unzip(buildZip({ 'Übersicht.tex': { data: doc, flags: 0x800 } }));
eq(Object.keys(files), ['Übersicht.tex'], 'flag bit 11: UTF-8');
files = unzip(buildZip({ 'Übersicht.tex': doc }));
eq(Object.keys(files), ['Übersicht.tex'], 'valid UTF-8 without the flag (Info-ZIP on Linux/macOS) is UTF-8');
const cp437 = Buffer.concat([B('r'), Buffer.from([0x82]), B('sum'), Buffer.from([0x82]), B('.tex')]); // résumé.tex in cp437
files = unzip(buildZip({ x: { data: doc, nameBytes: cp437 } }));
eq(Object.keys(files), ['résumé.tex'], 'cp437 name (Windows Explorer, 7-Zip)');
const cp437Sub = Buffer.concat([B('Anh'), Buffer.from([0x84]), B('nge/Stra'), Buffer.from([0xe1]), B('e.tex')]); // Anhänge/Straße.tex
files = unzip(buildZip({ x: { data: doc, nameBytes: cp437Sub } }));
eq(Object.keys(files), ['Anhänge/Straße.tex'], 'cp437 with a 0x80-0xAF byte decides the whole name');
const latin1 = Buffer.concat([B('Stra'), Buffer.from([0xdf]), B('e-'), Buffer.from([0xdc]), B('bersicht.tex')]); // Straße-Übersicht.tex
files = unzip(buildZip({ x: { data: doc, nameBytes: latin1 } }));
eq(Object.keys(files), ['Straße-Übersicht.tex'], 'high bytes only in cp437 box-drawing range: Latin-1');
const raw = Buffer.from([0x82, 0x2e, 0x74, 0x65, 0x78]);
files = unzip(buildZip({ x: { data: doc, nameBytes: raw, extra: unicodePathExtra(raw, 'é-from-extra.tex') } }));
eq(Object.keys(files), ['é-from-extra.tex'], 'Info-ZIP unicode path extra wins when its CRC matches');
files = unzip(buildZip({ x: { data: doc, nameBytes: raw, extra: unicodePathExtra(B('other'), 'stale.tex') } }));
eq(Object.keys(files), ['é.tex'], 'unicode path extra with a stale CRC is ignored');

// ---- damaged directories ----
const truncated = buildZip({ 'main.tex': doc, 'b.tex': doc });
truncated.writeUInt16LE(3, truncated.length - 22 + 10);
await throws(() => unzip(truncated), 'central directory is damaged (entry 3 of 3 is missing)', 'count past the directory');
const badLocal = buildZip({ 'main.tex': doc });
badLocal.writeUInt32LE(0, 0);
await throws(() => unzip(badLocal), 'local header of entry "main.tex" is missing', 'local header signature gone');
const badDeflate = buildZip({ 'main.tex': { data: 'not deflate data', method: 8 } });
// method 8 compresses in the builder; overwrite the stored bytes with junk
const start = 30 + 'main.tex'.length;
badDeflate.fill(0xff, start, start + 8);
await throws(() => unzip(badDeflate), 'entry "main.tex" has damaged deflate data', 'corrupt deflate stream');
await throws(() => unzip(B('PK\x03\x04 nothing else')), 'not a zip file', 'no EOCD');
await throws(() => unzip(buildZip({ 'zeros.bin': { data: Buffer.alloc(41 * 1024 * 1024), method: 8 } })),
  'entry "zeros.bin" is 41 MB unpacked; the limit per file is 40 MB', 'deflate entry past the per-file cap is refused before inflating');
files = unzip(buildZip({ 'blob.bin': Buffer.alloc(41 * 1024 * 1024) }));
eq(files['blob.bin'].length, 41 * 1024 * 1024, 'a stored entry has no per-file cap (bounded by the archive)');

console.log('unzip: all checks passed');
