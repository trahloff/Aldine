/**
 * The edits that turn `before` into `after` (a formatter's answer for the
 * same text), as small as a line-by-line comparison finds them: per changed
 * line only its indentation and its trailing blanks, or, when its text
 * changed too, what lies between its common prefix and suffix. A
 * re-indented line is one whitespace edit at its start.
 * Applied as one transaction, every untouched character keeps its identity
 * in the shared document, and collaborators' cursors and comment anchors on
 * them stay where they were.
 *
 * Indentation keeps the line count. When it changed anyway, the text between
 * the common start and end of the two is replaced as one block.
 */
export interface TextChange { from: number; to: number; insert: string }

function spanChange(a: string, b: string, at: number): TextChange | null {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { from: at + p, to: at + a.length - s, insert: b.slice(p, b.length - s) };
}

const EDGES = /^([ \t]*)(.*?)([ \t]*)$/;

/** A line whose text stayed and whose indentation or trailing blanks did not: one edit at each end. */
function lineChanges(a: string, b: string, at: number): TextChange[] {
  if (a === b) return [];
  const [, leadA, bodyA, trailA] = EDGES.exec(a)!;
  const [, leadB, bodyB, trailB] = EDGES.exec(b)!;
  if (bodyA !== bodyB) return [spanChange(a, b, at)!];
  const lead = spanChange(leadA, leadB, at);
  const trail = spanChange(trailA, trailB, at + leadA.length + bodyA.length);
  return [lead, trail].filter((c): c is TextChange => c !== null);
}

export function formatChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  const changes: TextChange[] = [];
  if (a.length === b.length) {
    let at = 0;
    for (let i = 0; i < a.length; i++) {
      changes.push(...lineChanges(a[i], b[i], at));
      at += a[i].length + 1;
    }
    return changes;
  }
  const whole = spanChange(before, after, 0);
  return whole ? [whole] : [];
}
