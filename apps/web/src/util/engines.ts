import type { CompilerInfo, ImportedProject } from '../api';

/** The engines the server accepts (PATCH rejects anything else with 400). */
export const ENGINES: Array<{ id: string; label: string }> = [
  { id: 'pdf', label: 'pdfLaTeX' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' },
];

export function engineLabel(id: string): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
}

/** "2026, full" for the settings panel; honest wording when the compiler
 *  is older than the report or not reachable at all. */
export function texliveLabel(info: CompilerInfo | null): string {
  if (!info) return 'Checking the compiler';
  if (!info.ok) return 'Compiler not reachable';
  const { release, scheme } = info.texlive;
  if (release === 'unknown' && scheme === 'unknown') return 'Not reported by this compiler';
  if (scheme === 'unknown') return release;
  if (release === 'unknown') return `unknown release, ${scheme}`;
  return `${release}, ${scheme}`;
}

/** The import toast: which compiler the project got and, briefly, why, plus
 *  any files transcoded to UTF-8. The server names only the files, not the
 *  encoding each was read as (Windows-1252, Latin-9 or Mac Roman), so the
 *  wording stays neutral. It lives a few seconds under the loading editor,
 *  so the settings panel repeats the reason at length. */
export function importSummary(p: Pick<ImportedProject, 'name' | 'import'>): string {
  const { engine, engineReason, transcoded } = p.import;
  const compiler = engineReason ? `${engineLabel(engine)} (${engineReason})` : engineLabel(engine);
  const enc = transcoded.length === 0 ? '' : transcoded.length === 1
    ? `. ${transcoded[0]} was not UTF-8 and has been transcoded`
    : `. ${transcoded.length} files were not UTF-8 and have been transcoded`;
  return `Imported ${p.name}: ${compiler}${enc}`;
}
