import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { gitlabConfig } from './config.js';
import { api, encodePath, gitlab, serviceConnection } from './gitlab.js';
import { getConnection } from './remotes.js';
import type { RemoteConnection } from './remotes.js';
import { isTextFile, newId } from './util.js';

/**
 * Templates hosted as GitLab projects: every project in the nominated group is
 * offered in the New project dialog, and the chosen one is cloned to seed the
 * new project.
 *
 * The clone is deliberately detached — history and remote are dropped, so a
 * project from a template starts with its own "Initial commit" and is free to
 * be mirrored to its own GitLab home. A template is a starting point, not a
 * parent: updating the template must never rewrite projects made from it.
 */

export interface GitlabTemplate {
  /** Full path, e.g. research/latex/templates/thesis. */
  fullPath: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
  cloneUrl: string;
  defaultBranch: string;
}

/** Templates come from GitLab only when a group is nominated. */
export function gitlabTemplatesEnabled(): boolean {
  return !!gitlabConfig.templateGroup;
}

/**
 * The user's own token first so a private templates group works for people who
 * connected GitLab themselves; the service account is the fallback that makes
 * templates visible to everyone else.
 */
async function connect(userId: string): Promise<RemoteConnection | null> {
  return (await getConnection(userId, 'gitlab')) || serviceConnection();
}

/**
 * Optional per-template metadata, committed as template.json at the repo root.
 * Only presentation is taken from it — the project's own name and description
 * are the defaults, so a template needs no manifest at all.
 */
interface Manifest { name?: string; description?: string; icon?: string; order?: number }

async function readManifest(conn: RemoteConnection, fullPath: string, ref: string): Promise<Manifest> {
  try {
    const raw = await api(conn, `/projects/${encodePath(fullPath)}/repository/files/template.json/raw?ref=${encodeURIComponent(ref)}`);
    return raw && typeof raw === 'object' ? (raw as Manifest) : {};
  } catch {
    return {};
  }
}

/**
 * Cached listing. The TTL exists so opening the dialog doesn't hit GitLab every
 * time; it also bounds how long a newly added template stays invisible, which is
 * why it is seconds rather than minutes.
 */
const TTL_MS = Number(process.env.GITLAB_TEMPLATE_TTL_MS || 60_000);
let cache: { at: number; group: string; entries: GitlabTemplate[] } | null = null;

/** Drop the cached listing, so the next list call re-reads the group. */
export function invalidateTemplateCache(): void {
  cache = null;
}

/**
 * Every non-archived project in the group and its subgroups, as templates.
 * Returns [] rather than throwing: an unreachable GitLab must leave the New
 * project dialog usable, falling back to whatever local templates exist.
 */
export async function listGitlabTemplates(userId: string): Promise<GitlabTemplate[]> {
  const group = gitlabConfig.templateGroup.trim();
  if (!group) return [];
  if (cache && cache.group === group && Date.now() - cache.at < TTL_MS) return cache.entries;

  const conn = await connect(userId);
  if (!conn) return [];
  let projects: any[];
  try {
    projects = await api(conn, `/groups/${encodePath(group)}/projects?include_subgroups=true&archived=false&order_by=name&sort=asc&per_page=100`) || [];
  } catch (err: any) {
    console.warn(`[gitlab] could not list templates in ${group}: ${err.message}`);
    return [];
  }

  const entries = await Promise.all(projects.map(async (p): Promise<GitlabTemplate> => {
    const fullPath = p.path_with_namespace;
    const branch = p.default_branch || 'main';
    const m = await readManifest(conn, fullPath, branch);
    return {
      fullPath,
      name: m.name || p.name || p.path,
      description: m.description || p.description || undefined,
      icon: m.icon,
      order: m.order,
      cloneUrl: p.http_url_to_repo,
      defaultBranch: branch,
    };
  }));

  cache = { at: Date.now(), group, entries };
  return entries;
}

/** Total bytes a template may contribute, so a mis-nominated group can't seed a project with a dataset. */
const MAX_BYTES = Number(process.env.GITLAB_TEMPLATE_MAX_BYTES || 20 * 1024 * 1024);

/** Read a checkout into a seed map: text as strings (so placeholders apply), everything else as bytes. */
function readTree(base: string): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = {};
  let total = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(relPath); continue; }
      if (!e.isFile()) continue;
      if (relPath === 'template.json') continue;
      const abs = path.join(base, relPath);
      total += fs.statSync(abs).size;
      if (total > MAX_BYTES) throw new Error(`the template is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
      files[relPath] = isTextFile(relPath) ? fs.readFileSync(abs, 'utf8') : fs.readFileSync(abs);
    }
  };
  walk('');
  return files;
}

/**
 * Clone a template project and return its files. Throws on failure: unlike the
 * GitLab *mirror*, the template is the content the caller asked for, so a
 * silent fallback to a blank project would hand back the wrong document.
 */
export async function gitlabTemplateFiles(userId: string, fullPath: string): Promise<Record<string, string | Buffer>> {
  const list = await listGitlabTemplates(userId);
  const tpl = list.find((t) => t.fullPath === fullPath);
  if (!tpl) throw new Error(`unknown template: ${fullPath}`);
  const conn = await connect(userId);
  if (!conn) throw new Error('No GitLab connection is available');

  const tmp = path.join(os.tmpdir(), `aldine-tpl-${newId(8)}`);
  try {
    await simpleGit().clone(gitlab.tokenUrl(tpl.cloneUrl, conn.token), tmp, [
      '--depth', '1', '--branch', tpl.defaultBranch, '--single-branch',
    ]);
    return readTree(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
