/** Distinct file paths touched by a unified git patch (diff --git headers). */
export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const i = line.lastIndexOf(' b/');
    if (i !== -1) files.add(line.slice(i + 3));
  }
  return [...files];
}
