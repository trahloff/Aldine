import { countColumn, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * The columns a line's leading whitespace fills, tabs to the next tab stop;
 * 0 for a line that is only whitespace, which never wraps.
 */
export function leadingColumns(text: string, tabSize: number): number {
  const lead = /^[ \t]*/.exec(text)![0];
  if (lead.length === text.length) return 0;
  return countColumn(lead, tabSize);
}

/** Past this share of the text width the continuation keeps the left edge. */
const MAX_SHARE = 0.5;

// CodeMirror's base theme pads .cm-line 6px on the left; the inline padding
// replaces that, so it is added back.
const BASE_PAD_PX = 6;

const lineDecos = new Map<number, Decoration>();
function lineDeco(cols: number): Decoration {
  let d = lineDecos.get(cols);
  if (!d) {
    d = Decoration.line({
      class: 'cm-wrapIndent',
      attributes: { style: `padding-left: calc(${cols}ch + ${BASE_PAD_PX}px); text-indent: -${cols}ch` },
    });
    lineDecos.set(cols, d);
  }
  return d;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const maxCols = Math.floor((view.contentDOM.clientWidth * MAX_SHARE) / (view.defaultCharacterWidth || 8));
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const cols = leadingColumns(line.text, state.tabSize);
      if (cols > 0 && cols <= maxCols) b.add(line.from, line.from, lineDeco(cols));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/**
 * Wrapped rows of an indented line continue under its indentation, not at
 * the left edge. Presentation only: the text is never touched. Assumes the
 * monospace source font, where `ch` is one column.
 */
export const wrapIndent = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  width: number;
  constructor(view: EditorView) {
    this.width = view.contentDOM.clientWidth;
    this.decorations = build(view);
  }
  update(u: ViewUpdate) {
    const width = u.view.contentDOM.clientWidth;
    if (u.docChanged || u.viewportChanged || u.startState.tabSize !== u.state.tabSize || width !== this.width) {
      this.width = width;
      this.decorations = build(u.view);
    }
  }
}, { decorations: (p) => p.decorations });
