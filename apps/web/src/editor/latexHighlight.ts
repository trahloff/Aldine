import { HighlightStyle, LanguageSupport } from '@codemirror/language';
import { styleTags, tags as t, type Tag } from '@lezer/highlight';
import { latex, latexLanguage } from 'codemirror-lang-latex';

/**
 * codemirror-lang-latex specializes every command it knows into its own token
 * (CiteCtrlSeq, ItemCtrlSeq, ...) and tags only some of them, so the rest render
 * as plain text. Every control-sequence and control-symbol token in the grammar
 * gets the command tag here, derived from the node set so tokens added by a
 * package upgrade are covered too.
 */
const COMMAND_TOKEN = /^(CtrlSeq|CtrlSym|Csname|\w+CtrlSeq|\w+CtrlSym)$/;

/** Tokens whose package styling is distinct and already visible. */
const KEEP = new Set([
  'BookCtrlSeq', 'PartCtrlSeq', 'ChapterCtrlSeq', 'SectionCtrlSeq', 'SubSectionCtrlSeq',
  'SubSubSectionCtrlSeq', 'ParagraphCtrlSeq', 'SubParagraphCtrlSeq',
  'TitleCtrlSeq', 'AuthorCtrlSeq', 'DateCtrlSeq', 'BibliographyCtrlSeq', 'BibliographyStyleCtrlSeq',
]);

const SPECIFIC: Record<string, Tag> = {
  LabelCtrlSeq: t.labelName,
  RefCtrlSeq: t.labelName,
  RefStarrableCtrlSeq: t.labelName,
  CiteCtrlSeq: t.labelName,
  CiteStarrableCtrlSeq: t.labelName,
  NewCommandCtrlSeq: t.definitionKeyword,
  RenewCommandCtrlSeq: t.definitionKeyword,
  NewEnvironmentCtrlSeq: t.definitionKeyword,
  RenewEnvironmentCtrlSeq: t.definitionKeyword,
  DefCtrlSeq: t.definitionKeyword,
  LetCtrlSeq: t.definitionKeyword,
  // \( \) \[ \] delimit math, like $
  OpenParenCtrlSym: t.processingInstruction,
  CloseParenCtrlSym: t.processingInstruction,
  OpenBracketCtrlSym: t.processingInstruction,
  CloseBracketCtrlSym: t.processingInstruction,
};

function commandTags(): Record<string, Tag> {
  const spec: Record<string, Tag> = {};
  for (const type of latexLanguage.parser.nodeSet.types) {
    if (!COMMAND_TOKEN.test(type.name) || KEEP.has(type.name)) continue;
    spec[type.name] = SPECIFIC[type.name] ?? t.keyword;
  }
  // the star of \section* \cite* \ref* \caption* is an anonymous token: it takes its parent's tag
  spec['Cite Ref'] = t.labelName;
  spec.Caption = t.keyword;
  spec.SectioningCommand = t.heading;
  // formatting applies to the argument; the command name keeps the command color
  spec['TextBoldCommand/TextArgument/...'] = t.strong;
  spec['TextItalicCommand/TextArgument/... EmphasisCommand/TextArgument/...'] = t.emphasis;
  return spec;
}

/** The LaTeX language with every control sequence tagged. */
export const latexHighlightLanguage = latexLanguage.configure({ props: [styleTags(commandTags())] });

/** `latex()` from codemirror-lang-latex, on the fully tagged language. */
export function aldineLatex(config: Parameters<typeof latex>[0] = {}): LanguageSupport {
  return new LanguageSupport(latexHighlightLanguage, latex(config).support);
}

/** Calm, ink-blue syntax palette that flips with the color scheme via CSS vars. */
export const aldineHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.tagName, t.macroName, t.function(t.variableName)], color: 'var(--syn-command)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.string, t.attributeValue, t.inserted], color: 'var(--syn-string)' },
  { tag: [t.number, t.literal, t.bool, t.escape], color: 'var(--syn-value)' },
  { tag: [t.labelName, t.typeName, t.attributeName, t.className], color: 'var(--syn-value)' },
  { tag: [t.heading], fontWeight: '600', color: 'var(--text)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: [t.processingInstruction, t.meta, t.bracket], color: 'var(--text-2)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
]);
