import { indentService } from '@codemirror/language';
import { countColumn, type EditorState, type Line } from '@codemirror/state';

/** How far up Enter looks for the line that opened the group a line closes. */
const MAX_LINES_UP = 2000;

interface Balance {
  opens: number;
  closes: number;
  /** the line ends in an optional argument's `[` */
  bracket: boolean;
}

function open(b: Balance): void { b.opens++; }
function close(b: Balance): void { if (b.opens) b.opens--; else b.closes++; }

/**
 * The groups a line of LaTeX leaves open, and the ones it closes that opened
 * on an earlier line. Groups are braces, environments and \[ \] or \( \)
 * math; escaped braces and comments do not count.
 */
function balance(text: string): Balance {
  const b: Balance = { opens: 0, closes: 0, bracket: false };
  let last = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '%') break;
    if (ch === '\\') {
      const env = /^\\(begin|end)[ \t]*\{[^{}]*\}/.exec(text.slice(i, i + 80));
      if (env) {
        (env[1] === 'begin' ? open : close)(b);
        i += env[0].length - 1;
      } else {
        const next = text[i + 1];
        if (next === '[' || next === '(') open(b);
        else if (next === ']' || next === ')') close(b);
        i++;
      }
      last = '\\';
      continue;
    }
    if (ch === '{') open(b);
    else if (ch === '}') close(b);
    if (ch !== ' ' && ch !== '\t') last = ch;
  }
  b.bracket = last === '[';
  return b;
}

const indentOf = (state: EditorState, line: Line) => countColumn(/^[ \t]*/.exec(line.text)![0], state.tabSize);

/**
 * Enter keeps the indentation of the line it breaks, one unit deeper when
 * that line leaves a group open or ends in `[`. A line that closes a group
 * opened further up takes the indentation of the line that opened it.
 *
 * codemirror-lang-latex's own rules put everything in a section body or an
 * environment one unit past the line the node starts on, which indents each
 * new line of a flush-left document body. Reindenting (no simulated break)
 * is still left to them.
 */
export const latexNewlineIndent = indentService.of((cx, pos) => {
  // simulatedBreak reads a break at 0 as none: Enter at the very start of the file stays with the language
  if (cx.simulatedBreak !== pos) return undefined;
  const { state } = cx;
  const line = state.doc.lineAt(pos);
  const b = balance(state.sliceDoc(line.from, pos));
  // empty when `{|}` is split onto three lines, since its `}` goes to the third
  for (const ch of cx.textAfterPos(pos)) {
    if (ch === '}') close(b);
    else if (ch !== ' ' && ch !== '\t') break;
  }
  let base = indentOf(state, line);
  for (let n = line.number - 1, need = b.closes; need > 0 && n >= Math.max(1, line.number - MAX_LINES_UP); n--) {
    const up = state.doc.line(n);
    const ub = balance(up.text);
    if (ub.opens >= need) { base = indentOf(state, up); break; }
    need += ub.closes - ub.opens;
  }
  return base + (b.opens > 0 || b.bracket ? cx.unit : 0);
});
