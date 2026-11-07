import { hiddenUploadName } from './fileTree';

/** One file of an upload, at its path below the folder it is uploaded into. */
export interface Picked { path: string; file: File }

/** What a drop holds: a folder's entry where the browser gives one, else the file. */
export interface DropRoot { entry: FileSystemEntry | null; file: File | null }

export interface Gathered {
  picked: Picked[];
  /** Entries that could not be read, by their path below the drop. */
  unreadable: string[];
  /** Dropped folders that held no file to upload, a dot-folder among them. */
  empty: string[];
  /** More than the limit: nothing is to be uploaded. */
  tooMany: boolean;
}

/**
 * The drop's files and folders. Read during the drop event itself: the
 * browser empties the items once the event returns. A drop built without
 * entries (another page's, a test's) still has its files.
 */
export function dropRoots(dt: DataTransfer): DropRoot[] {
  const roots: DropRoot[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    roots.push({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() });
  }
  if (!roots.length) for (const file of Array.from(dt.files ?? [])) roots.push({ entry: null, file });
  return roots;
}

/** A folder's entries: a reader hands them out in batches until one is empty. */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((ok, fail) => entry.file(ok, fail));

/**
 * Every file in the drop, a dropped folder's at their paths inside it.
 * Dot-files and dot-folders inside a folder (.git, .DS_Store) are left out; a
 * file dropped on its own is taken as chosen. Past `max` files the walk stops.
 */
export async function gatherDrop(roots: DropRoot[], max: number): Promise<Gathered> {
  const out: Gathered = { picked: [], unreadable: [], empty: [], tooMany: false };
  const take = (path: string, file: File) => {
    if (out.picked.length >= max) out.tooMany = true;
    else out.picked.push({ path, file });
  };
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (out.tooMany) return;
    if (entry.isDirectory) {
      let kids: FileSystemEntry[];
      try { kids = await readAll(entry as FileSystemDirectoryEntry); } catch { out.unreadable.push(path); return; }
      for (const k of kids) if (!hiddenUploadName(k.name)) await walk(k, `${path}/${k.name}`);
    } else if (entry.isFile) {
      try { take(path, await fileOf(entry as FileSystemFileEntry)); } catch { out.unreadable.push(path); }
    }
  };
  for (const { entry, file } of roots) {
    if (out.tooMany) break;
    if (entry?.isDirectory) {
      if (hiddenUploadName(entry.name)) { out.empty.push(entry.name); continue; }
      const before = out.picked.length + out.unreadable.length;
      await walk(entry, entry.name);
      if (out.picked.length + out.unreadable.length === before && !out.tooMany) out.empty.push(entry.name);
    } else if (file) take(file.name, file);
    else if (entry) await walk(entry, entry.name);
  }
  return out;
}

/** A folder chosen in the picker: each file at its path inside the folder,
 *  without dot-files and dot-folders. */
export function pickedFolder(files: readonly File[]): Picked[] {
  return files
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    .filter((p) => !p.path.split('/').some(hiddenUploadName));
}

/** Runs `run` over `items`, at most `limit` at a time. */
export async function runPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function toBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
