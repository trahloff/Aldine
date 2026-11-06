import { StateEffect } from '@codemirror/state';

/** Review-comment ranges pushed into the editor (shared by source + visual layers). */
export interface CommentRange {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
  suggestion?: string;
  quote?: string;
  /** What the commented text's card shows (editor/commentTips). */
  author?: string;
  body?: string;
  replies?: number;
}

export const setComments = StateEffect.define<CommentRange[]>();
