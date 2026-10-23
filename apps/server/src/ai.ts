import Anthropic from '@anthropic-ai/sdk';

/**
 * AI error-fix helper. Bring-your-own key, server-side only (never reaches the
 * browser). Two providers, auto-detected:
 *   - OpenRouter / any OpenAI-compatible endpoint  (OPENROUTER_API_KEY, or
 *     OPENAI_API_KEY + ALDINE_AI_BASE_URL)  — chat-completions format
 *   - Anthropic Messages API                        (ANTHROPIC_API_KEY)
 * Model and endpoint are env-configurable so it can point at a gateway or mock.
 */

type Provider = 'openrouter' | 'openai' | 'anthropic' | null;

function provider(): Provider {
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function aiConfigured(): boolean {
  return provider() !== null;
}

function model(): string {
  if (process.env.ALDINE_AI_MODEL) return process.env.ALDINE_AI_MODEL;
  const p = provider();
  if (p === 'openrouter') return 'anthropic/claude-opus-4.8';
  if (p === 'openai') return 'gpt-4o';
  return 'claude-opus-4-8';
}

export function aiModel(): string {
  return aiConfigured() ? model() : '';
}

/** ALDINE_AI_AUTOFIX=1: a failed typeset opens the Fix tab and diagnoses
 *  without a click. Off by default, since every new error costs a model call. */
export function aiAutoFix(): boolean {
  return aiConfigured() && process.env.ALDINE_AI_AUTOFIX === '1';
}

export interface AiFix { file: string; find: string; replace: string; note?: string }
export interface AiResult { explanation: string; fixes: AiFix[] }

interface DiagnoseInput {
  rootFile: string;
  files: Array<{ path: string; content: string }>;
  errors: Array<{ type: string; line: number | null; message: string; file?: string }>;
  log: string;
}

function numberLines(src: string): string {
  return src.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
}

function extractJson(text: string): AiResult {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  else {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  const parsed = JSON.parse(s) as Partial<AiResult>;
  return {
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : 'No explanation returned.',
    fixes: Array.isArray(parsed.fixes)
      ? parsed.fixes.filter((f) => f && typeof f.find === 'string' && typeof f.replace === 'string').map((f) => ({
          file: String(f.file || ''),
          find: String(f.find),
          replace: String(f.replace),
          note: f.note ? String(f.note) : undefined,
        }))
      : [],
  };
}

const SYSTEM = `You are a LaTeX expert helping a writer fix compilation errors in their document.
You are given the compiler error list, the tail of the compile log, and the project's .tex source files (with line numbers).
Diagnose the most likely cause and propose the smallest set of concrete edits that will make the document compile.

Respond with ONLY a JSON object, no preamble and no markdown fences:
{
  "explanation": "1-3 sentences in plain English: what went wrong and how the fix addresses it.",
  "fixes": [
    { "file": "main.tex", "find": "<exact substring currently in the file>", "replace": "<the corrected text>", "note": "short label" }
  ]
}
Rules: "find" MUST be an exact, unique substring of the current file content so it can be replaced verbatim (do not include the line-number prefixes shown in the source). Keep each fix minimal. If a needed package is missing, add the \\usepackage line via a fix that targets an existing preamble line. If you cannot determine a safe automatic fix, return an empty "fixes" array and explain what the user should check.`;

function buildUserPrompt(input: DiagnoseInput): string {
  const sources = input.files
    .map((f) => `--- ${f.path} ---\n${numberLines(f.content)}`)
    .join('\n\n')
    .slice(0, 40_000);
  const errs = input.errors
    .filter((e) => e.type === 'error')
    .slice(0, 20)
    .map((e) => `${e.file || input.rootFile}:${e.line ?? '?'} — ${e.message}`)
    .join('\n');
  return `Root file: ${input.rootFile}\n\nErrors:\n${errs || '(none parsed; see log)'}\n\nCompile log (tail):\n${input.log.slice(-3000)}\n\nSource files:\n${sources}`;
}

async function diagnoseOpenAICompatible(input: DiagnoseInput, base: string, key: string, extraHeaders: Record<string, string> = {}): Promise<AiResult> {
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({
      model: model(),
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI provider error (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content || '';
  return extractJson(text);
}

async function diagnoseAnthropic(input: DiagnoseInput): Promise<AiResult> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from env
  const resp = await client.messages.create({
    model: model(),
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
  });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

export async function diagnose(input: DiagnoseInput): Promise<AiResult> {
  const p = provider();
  if (p === 'openrouter') {
    return diagnoseOpenAICompatible(input, process.env.ALDINE_AI_BASE_URL || 'https://openrouter.ai/api/v1', process.env.OPENROUTER_API_KEY!, {
      'HTTP-Referer': 'https://github.com/aldine',
      'X-Title': 'Aldine',
    });
  }
  if (p === 'openai') {
    return diagnoseOpenAICompatible(input, process.env.ALDINE_AI_BASE_URL || 'https://api.openai.com/v1', process.env.OPENAI_API_KEY!);
  }
  return diagnoseAnthropic(input);
}
