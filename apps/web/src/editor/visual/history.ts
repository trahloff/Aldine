import { Facet } from '@codemirror/state';

/** Ends the open undo step: the edits after it are undone apart from the ones before. A no-op without a history. */
export const undoBoundary = Facet.define<() => void, () => void>({
  combine: (fs) => fs[fs.length - 1] ?? (() => {}),
});
