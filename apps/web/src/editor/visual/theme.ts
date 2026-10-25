import { EditorView } from '@codemirror/view';

/**
 * Visual-mode presentation: prose in the serif stack, rendered headings and
 * styles, editor chrome (gutters) tucked away. Colors ride the app CSS vars so
 * light/dark just work.
 */
export const visualTheme = EditorView.theme({
  // &.cm-editor beats app.css's .code-pane .cm-scroller mono rule on specificity
  '&.cm-editor .cm-scroller': { fontFamily: 'var(--font-serif)', fontSize: '16px', lineHeight: '1.65' },
  '.cm-content': { maxWidth: '46em', margin: '0 auto', padding: '24px 32px' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },

  '.cm-vis-h': { fontFamily: 'var(--font-ui)', fontWeight: '650', lineHeight: '1.3' },
  '.cm-vis-h1': { fontSize: '1.6em', paddingTop: '0.6em' },
  '.cm-vis-h2': { fontSize: '1.35em', paddingTop: '0.5em' },
  '.cm-vis-h3': { fontSize: '1.15em', paddingTop: '0.4em' },
  '.cm-vis-h4': { fontSize: '1em', paddingTop: '0.3em' },
  '.cm-vis-hrun': { fontFamily: 'var(--font-ui)', fontWeight: '650' },

  '.cm-vis-b': { fontWeight: '700' },
  '.cm-vis-i': { fontStyle: 'italic' },
  '.cm-vis-u': { textDecoration: 'underline' },
  '.cm-vis-sc': { fontVariant: 'small-caps' },

  '.cm-vis-math': { cursor: 'pointer', borderRadius: '4px', padding: '0 1px', position: 'relative' },
  // KaTeX's visually hidden MathML copy (for screen readers) sits inside the formula's box
  '.cm-vis-math .katex-mathml': { top: '0', left: '0' },
  '.cm-vis-math:hover': { background: 'var(--accent-soft)' },
  '.cm-vis-math--display': { display: 'block', textAlign: 'center', padding: '8px 0' },
  '.cm-vis-math--raw': { fontFamily: 'var(--font-mono)', fontSize: '0.85em', color: 'var(--syn-command)' },

  '.cm-vis-chip': {
    display: 'inline-flex', alignItems: 'baseline', gap: '5px', cursor: 'pointer',
    border: '1px solid var(--hairline)', borderRadius: '6px', padding: '1px 8px',
    background: 'var(--bg-inset)', fontFamily: 'var(--font-ui)', fontSize: '0.8em',
  },
  '.cm-vis-chip:hover': { borderColor: 'var(--hairline-strong)', background: 'var(--bg-hover)' },
  '.cm-vis-chip__kind': { textTransform: 'uppercase', fontSize: '0.75em', fontWeight: '700', color: 'var(--text-3)', letterSpacing: '0.06em' },
  '.cm-vis-chip--cite': { color: 'var(--accent)' },
  '.cm-vis-chip--ref': { color: 'var(--accent)' },
  '.cm-vis-sr': {
    position: 'absolute', width: '1px', height: '1px', padding: '0', margin: '-1px',
    overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: '0',
  },
  '.cm-vis-item': { color: 'var(--text-2)', paddingRight: '2px' },
  '.cm-vis-li': { paddingLeft: '1.4em' },

  '.cm-vis-strike': { textDecoration: 'line-through', textDecorationColor: 'var(--error)', opacity: '0.75' },
  '.cm-vis-suggest': { display: 'inline-flex', alignItems: 'center', gap: '3px', margin: '0 3px' },
  '.cm-vis-suggest__ins': { color: 'var(--ok)', textDecoration: 'underline', textDecorationStyle: 'dotted' },
  '.cm-vis-suggest__btn': {
    border: '1px solid var(--hairline)', background: 'var(--bg-inset)', color: 'var(--text-2)',
    borderRadius: '5px', fontSize: '11px', width: '24px', height: '24px', lineHeight: '1',
    cursor: 'pointer', padding: '0',
  },
  '.cm-vis-suggest__btn:hover': { color: 'var(--text)', borderColor: 'var(--hairline-strong)' },

  '.cm-vis-figure__img': { display: 'block', maxHeight: '140px', maxWidth: '100%', borderRadius: '4px', margin: '2px 0' },
  '.cm-vis-figure__cap': { display: 'block', fontSize: '0.85em', fontStyle: 'italic', color: 'var(--text-2)' },
  '.cm-vis-figure': { display: 'inline-block', padding: '6px 10px' },
  '.cm-vis-cap': { fontStyle: 'italic', color: 'var(--text-2)' },

  // a wide table scrolls sideways; its cells break between words, never inside one
  '.cm-vis-table': { display: 'inline-block', margin: '4px 0', maxWidth: '100%', overflowX: 'auto', verticalAlign: 'top' },
  '.cm-vis-table__grid': { borderCollapse: 'collapse', fontFamily: 'var(--font-serif)', fontSize: '0.95em' },
  '.cm-vis-table__grid td': {
    border: '1px solid var(--hairline)', padding: '3px 10px', cursor: 'text', minWidth: '40px',
    overflowWrap: 'normal', wordBreak: 'normal', hyphens: 'manual',
  },
  '.cm-vis-table__grid td:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  // an empty cell (a new row's) keeps a line's height, so it can still be hit
  '.cm-vis-table__grid td:empty::before': { content: '"\\200b"' },
  '.cm-vis-table__grid td:hover': { background: 'var(--bg-hover)' },
  '.cm-vis-table__bar': { display: 'flex', gap: '4px', marginTop: '3px' },
  '.cm-vis-table__btn': {
    border: '1px solid var(--hairline)', background: 'var(--bg-inset)', color: 'var(--text-2)',
    borderRadius: '5px', fontSize: '10.5px', fontFamily: 'var(--font-ui)', padding: '1px 7px', minHeight: '24px', cursor: 'pointer',
  },
  '.cm-vis-table__btn:hover': { color: 'var(--text)', borderColor: 'var(--hairline-strong)' },
  '.cm-vis-table__btn[aria-disabled="true"]': { opacity: '0.5', cursor: 'default', color: 'var(--text-2)', borderColor: 'var(--hairline)' },
  '.cm-vis-table__note': { alignSelf: 'center', fontFamily: 'var(--font-ui)', fontSize: '10.5px', color: 'var(--text-3)' },
  '.cm-vis-table__notice': { display: 'block', maxWidth: '40em', fontFamily: 'var(--font-ui)', fontSize: '0.8em', color: 'var(--text-2)', whiteSpace: 'normal' },
  '.cm-vis-table__notice:not(:empty)': { marginTop: '3px' },
  '.cm-vis-table__input': {
    font: 'inherit', color: 'inherit', background: 'var(--bg-panel)', border: '1px solid var(--accent)',
    borderRadius: '3px', padding: '1px 4px', width: '100%', boxSizing: 'border-box',
  },
  // thumbs: the desktop sizes above are too small to hit reliably
  '@media (pointer: coarse)': {
    '.cm-vis-suggest__btn': { width: '32px', height: '32px', fontSize: '13px' },
    '.cm-vis-table__btn': { minHeight: '36px', padding: '4px 12px', fontSize: '13px' },
    '.cm-vis-table__note': { fontSize: '13px' },
  },
});
