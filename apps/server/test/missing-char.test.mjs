/**
 * XeLaTeX and LuaLaTeX typeset a character the font lacks as nothing and say
 * so only in the log. Those lines become one warning per character and font,
 * so a PDF that lost its Greek letters says why.
 */
import { createRequire } from 'node:module';
import { eq } from './assert.mjs';

const { parseLog } = createRequire(import.meta.url)('../../compiler/server.js');

const log = [
  'Missing character: There is no α (U+03B1) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no α (U+03B1) in font [lmroman10-regular]:mapping=tex-text;!',
  'Missing character: There is no ≤ ("2264) in font ec-lmr10!',
  'Missing character: There is no β (U+03B2) in font [lmroman10-regular]:mapping=tex-text;!',
].join('\n');

eq(parseLog(log), [
  { type: 'warning', line: null, message: 'Missing character: There is no α (U+03B1) in font lmroman10-regular' },
  { type: 'warning', line: null, message: 'Missing character: There is no ≤ (U+2264) in font ec-lmr10' },
  { type: 'warning', line: null, message: 'Missing character: There is no β (U+03B2) in font lmroman10-regular' },
], 'one warning per missing character and font, with the font as TeX names it');
