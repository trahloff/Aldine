import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/** Spellcheck on, '0' when this browser turned it off. */
export const SPELLCHECK = 'aldine.spellcheck';
/** The dictionary's language, a BCP 47 tag; unset follows the browser. */
export const SPELLCHECK_LANG = 'aldine.spellcheckLang';

/** '' leaves the language to the browser (the page is English). */
export const SPELL_LANGS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Browser default' },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'de-DE', label: 'German' },
  { id: 'fr-FR', label: 'French' },
  { id: 'es-ES', label: 'Spanish' },
  { id: 'it-IT', label: 'Italian' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
  { id: 'pt-PT', label: 'Portuguese (Portugal)' },
  { id: 'nl-NL', label: 'Dutch' },
  { id: 'sv-SE', label: 'Swedish' },
  { id: 'da-DK', label: 'Danish' },
  { id: 'nb-NO', label: 'Norwegian' },
  { id: 'fi-FI', label: 'Finnish' },
  { id: 'pl-PL', label: 'Polish' },
  { id: 'cs-CZ', label: 'Czech' },
  { id: 'tr-TR', label: 'Turkish' },
  { id: 'ru-RU', label: 'Russian' },
];

export const spellLangKnown = (id: string | null): id is string => !!id && SPELL_LANGS.some((l) => l.id === id);

/** Prose files: the ones a spellchecker has anything to say about. */
export const spellcheckable = (path: string) => /\.(tex|md|txt)$/i.test(path);

const MATH_ENVS = 'equation|align|gather|multline|flalign|alignat|eqnarray|math|displaymath';
const CODE_ENVS = 'verbatim|Verbatim|lstlisting|minted|comment';
/** Commands whose first braced argument is a name, a key or a path, never prose. */
const NAME_ARGUMENT = [
  '[a-zA-Z]*cite[a-zA-Z]*', '[a-zA-Z]*ref', 'label', 'begin', 'end', 'usepackage', 'RequirePackage', 'documentclass',
  'input', 'include', 'includeonly', 'includegraphics', 'includepdf', 'bibliography', 'bibliographystyle', 'addbibresource',
  'url', 'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator',
  'setlength', 'addtolength', 'setcounter', 'newcounter', 'pagestyle', 'thispagestyle', 'color', 'textcolor', 'colorbox',
  'lstinputlisting', 'subfile', 'graphicspath', 'hypersetup', 'geometry', 'newtheorem', 'bibitem', 'cline', 'multicolumn', 'multirow',
].join('|');

const UNSPELLED = new RegExp([
  `\\\\begin\\{(${CODE_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`,
  `\\\\begin\\{(${MATH_ENVS})\\*?\\}[\\s\\S]*?\\\\end\\{\\2\\*?\\}`,
  '\\$\\$[\\s\\S]*?\\$\\$',
  '\\$(?:\\\\.|[^$\\\\])*\\$',
  '\\\\\\([\\s\\S]*?\\\\\\)',
  '\\\\\\[[\\s\\S]*?\\\\\\]',
  `\\\\(?:${NAME_ARGUMENT})\\*?(?:\\s*\\[[^\\]]*\\])*\\s*\\{[^{}]*\\}`,
  '\\\\(?:[a-zA-Z@]+\\*?|.)',
].join('|'), 'g');

/**
 * What of a LaTeX source no spellchecker should read, as sorted,
 * non-overlapping [from, to) offsets: commands, math, verbatim, and the
 * keys, labels and paths commands take. Comments are prose and stay.
 */
export function unspelledRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  UNSPELLED.lastIndex = 0;
  for (let m = UNSPELLED.exec(text); m; m = UNSPELLED.exec(text)) {
    const from = m.index, to = m.index + m[0].length;
    if (to === from) { UNSPELLED.lastIndex++; continue; }
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

const unspelled = Decoration.mark({ attributes: { spellcheck: 'false' } });

/** How far above the viewport a scan may start: a blank line ends any math or argument before it. */
const LOOK_BACK = 20_000;
const LOOK_AHEAD = 4_000;

function build(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  let done = 0;
  for (const { from, to } of view.visibleRanges) {
    const head = doc.sliceString(Math.max(0, from - LOOK_BACK), from);
    const blank = head.lastIndexOf('\n\n');
    const start = blank < 0 ? Math.max(0, from - LOOK_BACK) : from - head.length + blank;
    const end = Math.min(doc.length, to + LOOK_AHEAD);
    for (const [a, b] of unspelledRanges(doc.sliceString(start, end))) {
      const f = Math.max(start + a, from, done), t = Math.min(start + b, to);
      if (t > f) { builder.add(f, t, unspelled); done = t; }
    }
  }
  return builder.finish();
}

/** spellcheck="false" over the source no dictionary knows, in the part of the file on screen. */
const unspelledSource = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
}, { decorations: (v) => v.decorations });

/** The browser's spellcheck on prose files, in `lang` when one is chosen; never inside LaTeX commands. */
export function spellcheckExtension(on: boolean, lang: string, filePath: string): Extension {
  const active = on && spellcheckable(filePath);
  return [
    EditorView.contentAttributes.of({
      spellcheck: active ? 'true' : 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      ...(active && lang ? { lang } : {}),
    }),
    active && /\.tex$/i.test(filePath) ? unspelledSource : [],
  ];
}
