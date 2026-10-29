import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Writes of state that cannot be regenerated: the JSON datastore, the Yjs
 * snapshots, the signing secret. A rename alone is not enough: ext4 with
 * delayed allocation, XFS and many network volumes can persist the rename
 * before the data, so a crash or a forced read-only remount leaves a
 * zero-length or zero-filled file under the real name. The data is flushed
 * before the rename, and the directory after it so the rename itself lasts.
 */

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? '';

/** Errors of opening or syncing a directory on platforms and network
 *  filesystems that do not support it. There the rename is as durable as
 *  that filesystem makes it. */
const DIR_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'EBADF', 'ENOTSUP', 'EOPNOTSUPP']);

/** link() errors of volumes without hard links (SMB, some FUSE/9p mounts, vfat). */
export const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

/** Flush a directory's entries (a rename, a new link) to stable storage. */
export function fsyncDir(dir: string): void {
  let fd: number;
  try { fd = fs.openSync(dir, 'r'); } catch (err) {
    if (DIR_SYNC_UNSUPPORTED.has(code(err))) return;
    throw err;
  }
  try { fs.fsyncSync(fd); } catch (err) {
    if (!DIR_SYNC_UNSUPPORTED.has(code(err))) throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/** Write a whole file and flush it before returning. `flag` as for
 *  fs.open ('w' truncates, 'wx' refuses an existing file); `mode` applies
 *  only when the file is created. */
export function writeFileSynced(file: string, data: string | Uint8Array, opts: { mode?: number; flag?: string } = {}): void {
  const fd = fs.openSync(file, opts.flag ?? 'w', opts.mode ?? 0o666);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Replace `file` with `data` so that after a crash at any point it holds
 *  either its old or its new bytes in full. The temp file sits beside it
 *  (rename is only atomic within one filesystem) and is removed on failure. */
export function replaceFileDurable(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSynced(tmp, data, { mode: opts.mode, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* a read-only volume keeps it */ }
    throw err;
  }
  fsyncDir(path.dirname(file));
}
