import fs from 'node:fs';
import * as gitops from './gitops.js';
import { branchDir } from './store.js';
import { flushBranchDocs } from './collab.js';
import type { ProjectMeta } from './db/types.js';

/** ASCII file name for a project archive, the fallback beside the UTF-8 one
 *  in the header: anything outside letters, digits, dot, dash and underscore
 *  becomes a dash. */
export function archiveFolderName(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return ascii || 'project';
}

/**
 * A branch's source as the ZIP a person downloads from the Share dialog: the
 * tracked tree from git archive, after the live documents are flushed and
 * committed so it matches the editor. A download is not a commit: with
 * manual commits the ZIP is the working tree, and the uncommitted edits stay
 * uncommitted. A branch nobody checked out has no live documents and no
 * working tree, so its ref is archived as it is.
 */
export async function branchArchive(meta: ProjectMeta, branch: string, author?: gitops.CommitAuthor): Promise<Buffer> {
  let tree = branch;
  if (fs.existsSync(branchDir(meta.id, branch))) {
    flushBranchDocs(meta.id, branch);
    if (meta.manualCommits) tree = await gitops.workingTreeId(meta.id, branch);
    else await gitops.autoCommit(meta.id, branch, 'aldine: autosave', author).catch(() => {});
  }
  return gitops.archiveZip(meta.id, branch, tree);
}
