import type { EditorView } from '@codemirror/view';
import { trackRange, untrack } from './positions';

/**
 * WYSIWYG math editing: clicking a rendered equation opens a floating
 * MathLive field. "Done" writes back only the span the person changed, as
 * one precise source edit (collaborative + undoable); "Edit source" drops
 * into raw source instead. A formula MathLive would rewrite (comments, line
 * breaks, alignment, labels) and a cold MathLive cache both go straight to
 * source.
 */

/** The button that leaves a widget for its LaTeX, in the formula editor and under a table. */
export const SOURCE_BUTTON = { label: 'Edit source', title: 'Edit the LaTeX source' };

interface MathTarget { innerFrom: number; innerTo: number; rect: DOMRect }

type MathField = HTMLElement & { value: string };
interface VirtualKeyboard extends EventTarget { visible: boolean; boundingRect: DOMRect; hide?: () => void }

let mathfieldReady: Promise<boolean> | null = null;
function ensureMathlive(): Promise<boolean> {
  if (!mathfieldReady) {
    mathfieldReady = import('mathlive')
      .then((m) => {
        // registers <math-field>; keep MathLive's sounds/telemetry off
        (m as { MathfieldElement?: { soundsDirectory?: string | null } }).MathfieldElement &&
          ((m as unknown as { MathfieldElement: { soundsDirectory: string | null } }).MathfieldElement.soundsDirectory = null);
        return true;
      })
      .catch(() => {
        // the next formula click tries again: a failed preload must not send every formula to source
        mathfieldReady = null;
        return false;
      });
  }
  return mathfieldReady;
}

/** Fetches MathLive (about 800 KB) while the browser is idle, so the first formula click need not wait for it. */
export function preloadMathlive(): void {
  if (mathfieldReady) return;
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(() => { void ensureMathlive(); }, { timeout: 5000 });
  else setTimeout(() => { void ensureMathlive(); }, 2000);
}

/**
 * From the click (or Ctrl+Enter) that opens the formula editor until its
 * field has focus, which waits for MathLive to load, keys would edit the
 * text at its old caret. The text gives up the keyboard at once, so no input
 * path (IME, a phone's keyboard) reaches it. What the keys type is held for
 * the field, and dropped if the formula opens as source instead. Escape, a
 * press anywhere but the formula editor or focus going elsewhere (the command
 * palette) gives up opening it, and keys work as usual again at once.
 */
function holdKeys(view: EditorView, giveUp: (focusView: boolean) => void) {
  let typed = '';
  let pop: HTMLElement | null = null;
  let held = true;
  const release = () => {
    if (!held) return '';
    held = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', elsewhere, true);
    window.removeEventListener('focusin', elsewhere, true);
    return typed;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      release();
      giveUp(true);
      return;
    }
    // the page's shortcuts; AltGr (Ctrl+Alt) and ⌥ type characters
    if (e.metaKey || (e.ctrlKey && !e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Backspace') typed = [...typed].slice(0, -1).join('');
    else if ([...e.key].length === 1) typed += e.key;
  };
  const elsewhere = (e: Event) => {
    if (pop && e.target instanceof Node && pop.contains(e.target)) return;
    release();
    giveUp(false);
  };
  view.contentDOM.blur();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', elsewhere, true);
  window.addEventListener('focusin', elsewhere, true);
  return {
    /** The formula editor is on the page: presses inside it are not elsewhere. */
    shown(el: HTMLElement) { pop = el; },
    /** Stops holding; returns what was typed meanwhile. */
    release,
  };
}

/**
 * Whether MathLive may edit this formula at all. It serialises the whole
 * formula its own way: comments and line breaks vanish, alignment `&` and
 * `\\` come back escaped or merged, \label moves. Those go to source editing.
 * Line breaks around the formula (`\begin{equation}` on a line of its own)
 * are outside every token, and an edit keeps them as they are.
 */
export function mathliveCanEdit(source: string): boolean {
  if (source.trim().includes('\n')) return false;
  if (/\\(?:label|tag|notag|nonumber|begin|end|intertext|ref|eqref)(?![A-Za-z])/.test(source)) return false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      if (source[i + 1] === '\\') return false;
      i++;
    } else if (ch === '%' || ch === '&') {
      return false;
    }
  }
  return true;
}

/** A TeX token with the source span it stands for (a brace group around a single token included). */
export interface MathToken { text: string; from: number; to: number }

/** Commands whose braced argument is text, where spaces are part of what is written. */
const TEXT_ARG = /^\\(?:text(?!style$)[a-z]*|mbox|hbox|fbox|makebox|framebox|emph)$/;

/**
 * `source` as TeX tokens, math-mode whitespace dropped and every brace group
 * holding a single token collapsed into that token: the form in which
 * MathLive's rewritings (`x^{2}` → `x^2`, `\frac{1}{2}` → `\frac12`,
 * spacing) compare equal to what the author wrote, while each token still
 * knows its bytes. Inside a text argument (`\text{a b}`) a run of spaces is a
 * token of its own, so adding or removing one is an edit.
 */
export function mathTokens(source: string): MathToken[] {
  let toks: MathToken[] = [];
  let depth = 0;
  // the brace depth of the open text argument, -1 in math
  let textDepth = -1;
  let textNext = false;
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (textDepth >= 0) toks.push({ text: ' ', from: i, to: j });
      i = j;
      continue;
    }
    if (ch === '\\') {
      const m = /^\\(?:[A-Za-z]+\*?|[^A-Za-z])?/.exec(source.slice(i))!;
      toks.push({ text: m[0], from: i, to: i + m[0].length });
      textNext = textDepth < 0 && TEXT_ARG.test(m[0]);
      i += m[0].length;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (textNext) textDepth = depth;
    } else if (ch === '}') {
      if (depth === textDepth) textDepth = -1;
      depth = Math.max(0, depth - 1);
    }
    textNext = false;
    toks.push({ text: ch, from: i, to: i + 1 });
    i++;
  }
  for (let changed = true; changed;) {
    changed = false;
    const out: MathToken[] = [];
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].text === '{' && toks[k + 2]?.text === '}' && toks[k + 1].text !== '{' && toks[k + 1].text !== '}') {
        out.push({ text: toks[k + 1].text, from: toks[k].from, to: toks[k + 2].to });
        k += 2;
        changed = true;
      } else {
        out.push(toks[k]);
      }
    }
    toks = out;
  }
  return toks;
}

function sameTokens(a: MathToken[], b: MathToken[]): boolean {
  return a.length === b.length && a.every((t, i) => t.text === b[i].text);
}

/** Whether MathLive reads `source` as the formula it would write itself (`canonical`). */
export function roundTrips(source: string, canonical: string): boolean {
  return sameTokens(mathTokens(source), mathTokens(canonical));
}

/**
 * The edit to the author's `raw` formula for a change made in MathLive.
 * `c0`/`c1` are MathLive's canonical serialisations before and after (they
 * differ only where the person changed something); `s1` is its everyday
 * serialisation after, which keeps untouched atoms as written and supplies
 * the new text. Only the tokens that changed are replaced: spacing, braces
 * and everything else outside them stay byte-for-byte. Null when the forms
 * don't line up, so nothing safe can be written.
 */
export function mathEdit(raw: string, c0: string, c1: string, s1: string): { from: number; to: number; insert: string } | null {
  const a0 = mathTokens(raw);
  const k0 = mathTokens(c0);
  const k1 = mathTokens(c1);
  const t1 = mathTokens(s1);
  if (!sameTokens(a0, k0)) return null;
  // the new text comes from s1 when it is the same formula as c1, else from c1 itself
  const src = sameTokens(t1, k1) ? { text: s1, toks: t1 } : { text: c1, toks: k1 };
  let p = 0;
  while (p < k0.length && p < k1.length && k0[p].text === k1[p].text) p++;
  let q = 0;
  while (q < k0.length - p && q < k1.length - p && k0[k0.length - 1 - q].text === k1[k1.length - 1 - q].text) q++;
  const end0 = k0.length - q;
  const end1 = k1.length - q;
  let from: number;
  let to: number;
  if (p < end0) {
    from = a0[p].from;
    to = a0[end0 - 1].to;
  } else {
    // pure insertion: after the previous token, or before the first one
    from = to = p > 0 ? a0[p - 1].to : (a0[0]?.from ?? raw.length - (raw.length - raw.trimStart().length));
  }
  let insert = p < end1 ? src.text.slice(src.toks[p].from, src.toks[end1 - 1].to) : '';
  // a control word must not run into a letter that follows it
  const word = /\\[A-Za-z]+$/;
  const before = raw.slice(0, from);
  const after = raw.slice(to);
  if (insert) {
    if (word.test(before) && /^[A-Za-z]/.test(insert)) insert = ` ${insert}`;
    if (word.test(insert) && /^[A-Za-z]/.test(after)) insert = `${insert} `;
  } else if (word.test(before) && /^[A-Za-z]/.test(after)) {
    insert = ' ';
  }
  return { from, to, insert };
}

let openPopover: { close(focusView: boolean): void } | null = null;
let openSeq = 0;

export function closeMathPopover(): void {
  openSeq++;
  openPopover?.close(false);
}

function keyboard(): VirtualKeyboard | undefined {
  return (window as { mathVirtualKeyboard?: VirtualKeyboard }).mathVirtualKeyboard;
}

export async function openMathEditor(view: EditorView, target: MathTarget): Promise<void> {
  closeMathPopover();
  const seq = ++openSeq;
  // the formula follows edits above it (or a collaborator's) while the editor is open
  const range = trackRange(view, target.innerFrom, target.innerTo);
  const toSource = () => {
    untrack(view, range);
    if (range.live) {
      const head = view.state.selection.main.head;
      if (head < range.from || head > range.to) {
        view.dispatch({ selection: { anchor: Math.min(range.from, view.state.doc.length) }, scrollIntoView: true });
      }
    }
    view.focus();
  };
  if (!mathliveCanEdit(view.state.doc.sliceString(range.from, range.to))) return toSource();
  const keys = holdKeys(view, (focusView) => {
    if (seq !== openSeq) return;
    closeMathPopover();
    if (focusView) view.focus();
  });
  const ok = await ensureMathlive();
  if (seq !== openSeq) { keys.release(); untrack(view, range); return; }
  const source = view.state.doc.sliceString(range.from, range.to);
  if (!ok || !range.live || !mathliveCanEdit(source)) { keys.release(); return toSource(); }

  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  // MathLive's virtual keyboard (on touch devices) styles itself from a [theme] ancestor
  document.body.setAttribute('theme', theme);

  const pop = document.createElement('div');
  keys.shown(pop);
  pop.className = 'vis-math-popover';
  pop.setAttribute('data-testid', 'math-popover');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', 'Edit formula');
  pop.style.position = 'fixed';
  pop.style.visibility = 'hidden';

  const mf = document.createElement('math-field') as MathField;
  mf.setAttribute('data-testid', 'math-field');
  mf.setAttribute('aria-label', 'Formula');
  mf.setAttribute('theme', theme);
  mf.value = source;
  pop.appendChild(mf);

  const notice = document.createElement('div');
  notice.className = 'vis-math-popover__notice';
  notice.setAttribute('role', 'alert');
  notice.setAttribute('data-testid', 'math-popover-notice');
  notice.hidden = true;
  pop.appendChild(notice);

  const bar = document.createElement('div');
  bar.className = 'vis-math-popover__bar';
  const done = document.createElement('button');
  done.textContent = 'Done';
  done.className = 'btn btn--primary vis-math-popover__btn';
  done.setAttribute('data-testid', 'math-popover-done');
  const tex = document.createElement('button');
  tex.textContent = SOURCE_BUTTON.label;
  tex.title = SOURCE_BUTTON.title;
  tex.className = 'btn vis-math-popover__btn';
  tex.setAttribute('data-testid', 'math-popover-source');
  bar.append(done, tex);
  pop.appendChild(bar);
  document.body.appendChild(pop);

  // MathLive's own canonical form of the untouched formula, read once it is
  // mounted: the baseline an edit is diffed against. A formula it would
  // write differently (beyond spacing and optional braces) goes to source.
  const canonical = () => (mf as unknown as { getValue(format: string): string }).getValue('latex-expanded');
  const c0 = canonical();
  if (!roundTrips(source, c0)) {
    pop.remove();
    keys.release();
    return toSource();
  }

  const place = () => {
    const kb = keyboard();
    const vv = window.visualViewport;
    let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    if (kb?.visible && kb.boundingRect.height > 0) bottom = Math.min(bottom, kb.boundingRect.top);
    const h = pop.offsetHeight;
    const w = pop.offsetWidth;
    let top = target.rect.bottom + 6;
    if (top + h > bottom - 8) top = target.rect.top - 6 - h; // above the formula
    if (top < 8) top = Math.max(8, bottom - 8 - h);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(target.rect.left, window.innerWidth - w - 8))}px`;
  };

  let overwrite = false;
  const say = (text: string) => { notice.textContent = text; notice.hidden = false; place(); };
  const close = (focusView: boolean) => {
    if (openPopover !== handle) return;
    openPopover = null;
    untrack(view, range);
    window.removeEventListener('mousedown', onOutside, true);
    keyboard()?.removeEventListener('geometrychange', place);
    window.visualViewport?.removeEventListener('resize', place);
    keyboard()?.hide?.();
    // blurred while still connected: MathLive keeps global focus state, and a
    // field removed while focused leaves the next one unable to take focus
    (mf as unknown as { blur(): void }).blur();
    pop.remove();
    if (focusView && range.live) view.focus();
  };
  const handle = { close };

  done.onclick = () => {
    const c1 = canonical();
    const s1 = mf.value;
    if (c1 === c0) return close(true);
    if (!range.live) return close(false);
    const current = view.state.doc.sliceString(range.from, range.to);
    if (current !== source) {
      // never silently: the person decides whether their version replaces the other one
      if (range.from === range.to) {
        done.disabled = true;
        return say('This formula was deleted while you were editing it. Nothing was written.');
      }
      if (!overwrite) {
        overwrite = true;
        return say('Someone else changed this formula while you were editing it. Press Done again to replace it with your version.');
      }
      view.dispatch({ changes: { from: range.from, to: range.to, insert: s1 }, userEvent: 'input.visual' });
      return close(true);
    }
    const edit = mathEdit(source, c0, c1, s1);
    if (!edit) return say(`This change can't be written without rewriting the rest of the formula, so nothing was written. Press ${SOURCE_BUTTON.label} to make it in the LaTeX instead.`);
    view.dispatch({ changes: { from: range.from + edit.from, to: range.from + edit.to, insert: edit.insert }, userEvent: 'input.visual' });
    close(true);
  };
  tex.onclick = () => { close(false); toSource(); };

  // capture: MathLive handles Escape and Tab inside its field before bubbling
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      done.click();
    } else if (e.key === 'Tab') {
      const order: HTMLElement[] = [mf, done, tex];
      const i = order.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); e.stopPropagation(); tex.focus(); }
      else if (!e.shiftKey && i === order.length - 1) { e.preventDefault(); e.stopPropagation(); mf.focus(); }
    }
  }, true);
  // keep the page's own shortcuts out of the field
  pop.addEventListener('keydown', (e) => e.stopPropagation());
  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (pop.contains(t) || (t instanceof Element && t.closest('.ML__keyboard, .ui-menu-container'))) return;
    close(false);
  };
  window.addEventListener('mousedown', onOutside, true);
  keyboard()?.addEventListener('geometrychange', place);
  window.visualViewport?.addEventListener('resize', place);

  openPopover = handle;
  place();
  pop.style.visibility = '';
  // after the click that opened it has finished: MathLive takes focus asynchronously
  requestAnimationFrame(() => {
    const typed = keys.release();
    if (openPopover !== handle) return;
    mf.focus();
    // one character at a time, as typing them would: a key MathLive takes as a shortcut is not inserted again
    const field = mf as unknown as { executeCommand(cmd: [string, ...unknown[]]): boolean };
    for (const ch of typed) field.executeCommand(['typedText', ch, { focus: true, feedback: false, simulateKeystroke: true }]);
  });
}
