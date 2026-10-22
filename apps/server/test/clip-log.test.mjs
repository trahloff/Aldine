/**
 * A long compile log keeps its head and its tail. Only the tail was kept, so
 * a 110 s benchmark's log arrived without the lines naming the engine, the
 * format and the packages, and nobody could say what the run had loaded.
 */
import { createRequire } from 'node:module';
import { check, eq } from './assert.mjs';

const { clipLog } = createRequire(import.meta.url)('../../compiler/server.js');

const short = 'This is pdfTeX\nOutput written on main.pdf (1 page, 100 bytes).\n';
eq(clipLog(short), short, 'a short log is untouched');

const lines = Array.from({ length: 20_000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(20)}`);
lines[0] = 'This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2026) (preloaded format=pdflatex)';
lines[lines.length - 1] = 'Output written on main.pdf (110 pages, 1234567 bytes).';
const log = lines.join('\n');
const clipped = clipLog(log);

check(log.length > 200_000, 'the fixture is over the limit');
check(clipped.length <= 200_100, `clipped to about 200 KB, got ${clipped.length}`);
check(clipped.startsWith('This is pdfTeX, Version'), 'the engine banner survives');
check(clipped.endsWith('(110 pages, 1234567 bytes).'), 'the page count survives');
const marker = clipped.match(/\n\[… (\d+) KB of the log left out …\]\n/);
check(marker, 'the cut is marked');
eq(Number(marker[1]), Math.ceil((log.length - (clipped.length - marker[0].length)) / 1000), 'the marker says how much went');
// whole lines on both sides of the cut
const [before, after] = clipped.split(marker[0]);
check(lines.includes(before.split('\n').pop()), 'the head ends on a whole line');
check(lines.includes(after.split('\n')[0]), 'the tail starts on a whole line');

console.log('clip-log: ok');
