import { StateField } from '@codemirror/state';
import type { EditorState, Text, Transaction } from '@codemirror/state';
import { rootPreambleText } from './context';
import { NO_MACROS, MacroSet, preambleMacros } from './preamble';
import { resourceArrived } from './refresh';

/** What the macros were read from: the file's own preamble (`end` is where \begin{document} starts) or none. */
interface MacroValue { end: number | null; own: string | null; set: MacroSet }

const BEGIN_DOC = /\\begin\s*\{document\}/;

/** The file's own preamble, read line by line up to \begin{document}. */
function ownPreamble(doc: Text): { end: number; text: string } | null {
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const code = line.text.replace(/(^|[^\\])%.*$/, '$1');
    const m = BEGIN_DOC.exec(code);
    if (m) {
      const end = line.from + m.index;
      return { end, text: doc.sliceString(0, end).replace(/(^|[^\\])%.*$/gm, '$1') };
    }
  }
  return null;
}

function read(doc: Text, prev: MacroSet | null): MacroValue {
  const own = ownPreamble(doc);
  const set = preambleMacros(own ? own.text : rootPreambleText());
  return { end: own?.end ?? null, own: own?.text ?? null, set: prev && prev.key === set.key ? prev : set };
}

/** Whether an edit can have changed what the preamble defines. */
function preambleTouched(value: MacroValue, tr: Transaction): boolean {
  let touched = false;
  tr.changes.iterChangedRanges((fromA, _toA, fromB, toB) => {
    if (value.end !== null) {
      if (fromA <= value.end + 16) touched = true;
      return;
    }
    // no preamble yet: only an edit that writes \begin{document} makes one
    const doc = tr.state.doc;
    if (doc.sliceString(doc.lineAt(fromB).from, doc.lineAt(toB).to).includes('document')) touched = true;
  });
  return touched;
}

/**
 * The math macros the formulas of this file can use: from its own preamble,
 * or the root file's for a file without one. Read again only when an edit
 * reaches the preamble, so typing in the body costs nothing.
 */
export const macroField = StateField.define<MacroValue>({
  create: (state) => read(state.doc, null),
  update(value, tr) {
    if (tr.docChanged && preambleTouched(value, tr)) return read(tr.state.doc, value.set);
    if (tr.effects.some((e) => e.is(resourceArrived)) && value.own === null) {
      const set = preambleMacros(rootPreambleText());
      return set.key === value.set.key ? value : { ...value, set };
    }
    if (tr.docChanged && value.end !== null) return { ...value, end: tr.changes.mapPos(value.end) };
    return value;
  },
});

/** The macros for `state`'s formulas; none where the field is not installed. */
export function macrosOf(state: EditorState): MacroSet {
  return state.field(macroField, false)?.set ?? NO_MACROS;
}
