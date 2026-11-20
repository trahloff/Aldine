/**
 * Classes such as acmart, amsart and IEEEtran keep the title, the authors
 * and the abstract until \maketitle typesets them, so SyncTeX names the
 * \maketitle line for a double-click anywhere in that block. The text the
 * reader double-clicked is then the only clue to where it came from.
 */

const MAKETITLE = /\\maketitle(?![A-Za-z@])/;
/** Fewer words than this in common with a source line is a coincidence, not a match. */
const MIN_RUN = 3;

/** The line's text without its comment, `\%` kept. */
function uncommented(line: string): string {
  const m = /(^|[^\\])(\\\\)*%/.exec(line);
  return m ? line.slice(0, m.index + m[0].length - 1) : line;
}

/** Lower-case words of letters and digits, LaTeX command names left out. */
export function plainWords(text: string): string[] {
  return text
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The longest run of `needle`'s words, in order, found in `hay`. */
function longestRun(needle: string[], hay: string[]): number {
  let best = 0;
  for (let i = 0; i < hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      let k = 0;
      while (i + k < hay.length && j + k < needle.length && hay[i + k] === needle[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

export type TitleBlockJump =
  /** Not the \maketitle line: SyncTeX's line stands. */
  | { kind: 'plain' }
  /** The source line above \maketitle that holds the clicked text. */
  | { kind: 'found'; line: number }
  /** \maketitle, and no line above it holds the clicked text. */
  | { kind: 'maketitle' };

/**
 * Where a SyncTeX jump to `line` (1-based) of `lines` should land, given the
 * text of the PDF span that was double-clicked.
 */
export function titleBlockJump(lines: readonly string[], line: number, clicked: string): TitleBlockJump {
  if (line < 1 || line > lines.length || !MAKETITLE.test(uncommented(lines[line - 1]))) return { kind: 'plain' };
  const words = plainWords(clicked);
  const need = Math.min(MIN_RUN, words.length);
  // A lone short word ("of", "2026") would match half the preamble.
  if (!need || (words.length === 1 && words[0].length < 5)) return { kind: 'maketitle' };
  let best = 0, at = 0;
  // Up from \maketitle: of equal matches, the nearest one.
  for (let n = line - 1; n >= 1; n--) {
    const run = longestRun(words, plainWords(uncommented(lines[n - 1])));
    if (run > best) { best = run; at = n; }
    if (best === words.length) break;
  }
  return best >= need ? { kind: 'found', line: at } : { kind: 'maketitle' };
}
