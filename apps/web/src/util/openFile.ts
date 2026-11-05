import { safeStorage, type SafeStore } from './safeStorage';

/** The file a project's branch had open last in this browser, which the
 *  editor opens again on the next visit while the file still exists. */
const key = (projectId: string, branch: string) => `aldine.openFile.${projectId}.${branch}`;

export function lastOpenFile(projectId: string, branch: string, store: SafeStore = safeStorage): string | null {
  return store.get(key(projectId, branch)) || null;
}

/** Without storage the next visit opens the root file. */
export function rememberOpenFile(projectId: string, branch: string, path: string, store: SafeStore = safeStorage): void {
  store.set(key(projectId, branch), path);
}
