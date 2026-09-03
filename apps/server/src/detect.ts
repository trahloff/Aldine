/**
 * Engine detection and text decoding for imported archives. Overleaf exports
 * that need XeLaTeX or LuaLaTeX fail silently under pdflatex, so the import
 * picks the engine the project asks for: an explicit build setting first
 * (latexmkrc, then a magic comment), the root file's package list last.
 */
export type Engine = 'pdf' | 'xelatex' | 'lualatex';

export interface EngineDetection {
  engine: Engine;
  /** Where the choice came from, for the import toast; null when nothing asked for a non-default engine. */
  reason: string | null;
}

// Only the head of the root is scanned: a preamble past this is not one a
// person wrote, and the 200 MB archive bound must stay cheap to honour.
const SNIFF_BYTES = 256 * 1024;

/** \usepackage or \RequirePackage naming any of the packages, outside a comment (an escaped \% opens none). */
const packageRe = (names: string[]) =>
  new RegExp(`^(?:[^%\\\\\\n]|\\\\.)*\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\]\\s*)?\\{[^}]*\\b(${names.join('|')})\\b[^}]*\\}`, 'm');
const LUA_PACKAGES = ['luacode', 'luatexbase', 'luaotfload', 'lualatex-math', 'luatextra', 'luamplib'];
// fontspec and unicode-math run on both engines; XeLaTeX is the one Overleaf
// picks for them and the one bidi/xepersian require outright.
const XE_PACKAGES = ['fontspec', 'unicode-math', 'polyglossia', 'xepersian', 'bidi', 'xeCJK', 'xltxtra', 'xunicode'];
const LUA_RE = packageRe(LUA_PACKAGES);
const XE_RE = packageRe(XE_PACKAGES);
// "% !TEX program = xelatex" (TeXShop/TeXworks/VS Code), "TS-program" is the TeXShop spelling.
const MAGIC_RE = /^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im;

function engineFromProgram(name: string): Engine | null {
  const n = name.toLowerCase();
  if (n === 'xelatex' || n === 'xetex') return 'xelatex';
  if (n === 'lualatex' || n === 'luatex' || n === 'luahbtex') return 'lualatex';
  if (n === 'pdflatex' || n === 'latex' || n === 'pdftex') return 'pdf';
  return null;
}

/**
 * latexmk's own precedence, reduced: $pdf_mode selects the engine (4 = xelatex,
 * 5 = lualatex, 1 = pdflatex); without it, a $pdflatex command naming xelatex
 * or lualatex (the pre-4.51 idiom); without either, a bare $xelatex or
 * $lualatex assignment is the only remaining hint, and only when it stands
 * alone: an rc that assigns both (the idiom that hands -shell-escape to
 * whichever engine runs) chooses none, like a $pdflatex line that names
 * pdflatex, so the root file still decides. Lines after `#` are comments.
 */
export function engineFromLatexmkrc(text: string): Engine | null {
  const code = text.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const mode = code.match(/\$pdf_mode\s*=\s*['"]?(\d)/);
  if (mode) {
    if (mode[1] === '4') return 'xelatex';
    if (mode[1] === '5') return 'lualatex';
    if (mode[1] === '1') return 'pdf';
  }
  const cmd = code.match(/\$pdflatex\s*=\s*['"]\s*(\S+)/);
  if (cmd) {
    const e = engineFromProgram(cmd[1].split('/').pop()!);
    if (e && e !== 'pdf') return e;
  }
  const hasLua = /\$lualatex\s*=/.test(code);
  const hasXe = /\$xelatex\s*=/.test(code);
  if (hasLua && hasXe) return null;
  if (hasLua) return 'lualatex';
  if (hasXe) return 'xelatex';
  return null;
}

/** Engine the root file's preamble requires, or null when pdflatex would do. */
export function engineFromSource(text: string): { engine: Engine; reason: string } | null {
  const magic = text.match(MAGIC_RE);
  if (magic) {
    const e = engineFromProgram(magic[1]);
    if (e) return { engine: e, reason: `the "!TEX program" line in the main document` };
  }
  const lua = text.match(LUA_RE);
  if (lua) return { engine: 'lualatex', reason: `the ${lua[1]} package in the main document` };
  const xe = text.match(XE_RE);
  if (xe) return { engine: 'xelatex', reason: `the ${xe[1]} package in the main document` };
  return null;
}

/**
 * The engine an imported archive should typeset with. `files` are the placed
 * entries (project-relative paths), `root` the detected main document.
 * A latexmkrc beside the root wins over one elsewhere.
 */
export function detectEngine(files: Record<string, Buffer>, root: string | undefined): EngineDetection {
  const rootDir = root && root.includes('/') ? root.slice(0, root.lastIndexOf('/') + 1) : '';
  const rcs = Object.keys(files)
    .filter((p) => /(^|\/)\.?latexmkrc$/i.test(p))
    .sort((a, b) => Number(!a.startsWith(rootDir)) - Number(!b.startsWith(rootDir)) || a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const rc of rcs) {
    const engine = engineFromLatexmkrc(files[rc].toString('utf8'));
    if (engine) return { engine, reason: engine === 'pdf' ? null : `${rc} in the archive` };
  }
  if (root && files[root]) {
    const head = files[root].toString('utf8', 0, Math.min(files[root].length, SNIFF_BYTES));
    const found = engineFromSource(head);
    if (found) return found;
  }
  return { engine: 'pdf', reason: null };
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Node decodes the windows-1252 label as Latin-1, so the C1 range (the curly
// quotes, dashes, ellipsis and euro sign of Windows exports) is mapped here.
const CP1252_C1 = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';
const decodeCp1252 = (data: Buffer) => data.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80]);

const INPUTENC_RE = /(\\usepackage\s*\[)([^\]]*)(\]\s*\{inputenc\})/g;
/** inputenc options the transcode understands; each is replaced by utf8 afterwards. */
const LEGACY_OPTION_RE = /\b(latin1|latin9|ansinew|cp1252|applemac)\b/g;
// Windows-1252 is a superset of Latin-1 for every printable byte, so a
// [latin1] file decodes through it too; the other two differ and need their own.
const DECODER_FOR_OPTION: Record<string, string> = { latin9: 'iso-8859-15', applemac: 'macintosh' };

/**
 * Decode an imported text file. Bytes that are not UTF-8 are read as
 * Windows-1252 (Latin-1 plus the Windows punctuation of Word-era exports), or
 * as Latin-9 / Mac Roman when the file's inputenc option says so, and that
 * option is switched to utf8 so the transcoded file still compiles. A UTF-8
 * file with a stray byte is not transcoded: the multibyte characters it does
 * have are kept and the bad byte becomes U+FFFD, as before. Returns whether a
 * transcode happened.
 */
export function decodeText(data: Buffer): { text: string; transcoded: boolean } {
  try {
    return { text: utf8Strict.decode(data), transcoded: false };
  } catch {
    const lenient = data.toString('utf8');
    const valid = (lenient.match(/[^\x00-\x7f\ufffd]/g) ?? []).length;
    const bad = (lenient.match(/\ufffd/g) ?? []).length;
    if (valid >= bad) return { text: lenient, transcoded: false };
    let text = decodeCp1252(data);
    const option = Array.from(text.matchAll(INPUTENC_RE)).flatMap((m) => m[2].match(LEGACY_OPTION_RE) ?? []).find((o) => DECODER_FOR_OPTION[o]);
    if (option) text = new TextDecoder(DECODER_FOR_OPTION[option]).decode(data);
    text = text.replace(INPUTENC_RE, (m, open, opts, close) => {
      const swapped = opts.replace(LEGACY_OPTION_RE, 'utf8');
      return swapped === opts ? m : `${open}${swapped}${close}`;
    });
    return { text, transcoded: true };
  }
}
