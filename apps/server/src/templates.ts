import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isTextFile } from './util.js';
import { gitlabTemplateFiles, gitlabTemplatesEnabled, listGitlabTemplates } from './gitlab-templates.js';

/**
 * Starting points for a new project, from two sources at once:
 *
 *  - `TEMPLATES_DIR` on disk — one subdirectory per template, scanned on every
 *    request so a template dropped in appears without a restart.
 *  - a nominated GitLab group (`GITLAB_TEMPLATE_GROUP`) — one project per
 *    template, so templates get version control and merge requests.
 *
 * Both are optional and additive. A deployment that wants only its own
 * templates points TEMPLATES_DIR at a directory without the shipped ones.
 */

export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
  /** Where it came from, for the dialog to label; not part of the id. */
  source: 'local' | 'gitlab';
}

/** GitLab template ids carry the group path, which local ids may never contain. */
const GITLAB_PREFIX = 'gitlab:';

/** "iac-paper" → "Iac paper". Used when a template ships no template.json. */
function titleFromDir(dir: string): string {
  const words = dir.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function hasTex(dir: string): boolean {
  const walk = (rel: string): boolean => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).some((e) => {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(relPath) : /\.tex$/i.test(e.name);
  });
  try { return walk(''); } catch { return false; }
}

/**
 * Templates in `TEMPLATES_DIR`. `template.json` is optional — any subdirectory
 * holding a .tex file is a template, so a directory of papers works as-is.
 * Anything skipped is logged: a silently ignored folder is the failure mode
 * people spend an afternoon on.
 */
export function listLocalTemplates(): TemplateInfo[] {
/** Not a directory under templates/: a project with no files and no typeset
 *  root. Listed first so the grid leads with it and never hidden by an
 *  absent templates dir. */
export const BLANK_TEMPLATE: TemplateInfo = {
  id: 'blank', name: 'Blank', description: 'An empty project. Add the first file yourself.', icon: '▢', order: 0,
};

export function listTemplates(): TemplateInfo[] {
  const dir = config.templatesDir;
  if (!fs.existsSync(dir)) return [BLANK_TEMPLATE];
  const out: TemplateInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const base = path.join(dir, name);
    if (!fs.statSync(base).isDirectory()) continue;
    const metaPath = path.join(base, 'template.json');
    let meta: Partial<TemplateInfo> = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (err: any) {
        console.warn(`[templates] ignoring ${name}: template.json is not valid JSON (${err.message})`);
        continue;
      }
    } else if (!hasTex(base)) {
      console.warn(`[templates] ignoring ${name}: no template.json and no .tex file`);
      continue;
    }
    out.push({
      id: name,
      name: meta.name || titleFromDir(name),
      description: meta.description,
      icon: meta.icon,
      order: meta.order,
      source: 'local',
    });
  }
  return out;
}

/** Every template on offer, both sources merged. Ordered by `order`, then name. */
export async function listTemplates(userId: string): Promise<TemplateInfo[]> {
  const local = listLocalTemplates();
  const remote = gitlabTemplatesEnabled()
    ? (await listGitlabTemplates(userId)).map((t): TemplateInfo => ({
      id: `${GITLAB_PREFIX}${t.fullPath}`,
      name: t.name,
      description: t.description,
      icon: t.icon,
      order: t.order,
      source: 'gitlab',
    }))
    : [];
  return [...local, ...remote].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

/** All files of a local template (except template.json); text as strings, the rest as bytes. */
export function localTemplateFiles(id: string): Record<string, string | Buffer> {
  if (id.includes('..') || id.includes('/')) throw new Error('bad template id');
  const base = path.join(config.templatesDir, id);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error(`unknown template: ${id}`);
  const files: Record<string, string | Buffer> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else if (relPath !== 'template.json') {
        const abs = path.join(base, relPath);
        files[relPath] = isTextFile(relPath) ? fs.readFileSync(abs, 'utf8') : fs.readFileSync(abs);
      }
    }
  };
  walk('');
  return files;
}

/**
 * Values a template may interpolate. Kept small and explicit: every token is
 * documented, and an unknown `{{...}}` is left alone rather than blanked, so
 * ordinary LaTeX braces pass through untouched.
 */
export interface TemplateVars { PROJECT_NAME: string; AUTHOR: string; DATE: string; YEAR: string }

export function templateVars(projectName: string, author?: string): TemplateVars {
  const now = new Date();
  return {
    PROJECT_NAME: projectName,
    AUTHOR: author || '',
    DATE: now.toISOString().slice(0, 10),
    YEAR: String(now.getFullYear()),
  };
}

const TOKEN_RE = /\{\{\s*(PROJECT_NAME|AUTHOR|DATE|YEAR)\s*\}\}/g;

/** Substitute tokens in text files only — a binary is never a template body. */
export function applyPlaceholders(
  files: Record<string, string | Buffer>,
  vars: TemplateVars,
): Record<string, string | Buffer> {
  const out: Record<string, string | Buffer> = {};
  for (const [rel, content] of Object.entries(files)) {
    out[rel] = typeof content === 'string' ? content.replace(TOKEN_RE, (_m, k: keyof TemplateVars) => vars[k]) : content;
  }
  return out;
}

/**
 * Files for a template id from either source, with placeholders applied.
 * Throws when the template can't be read: the caller asked for this content, so
 * degrading to a blank project would hand back the wrong document.
 */
export async function templateFiles(id: string, userId: string, vars: TemplateVars): Promise<Record<string, string | Buffer>> {
  const files = id.startsWith(GITLAB_PREFIX)
    ? await gitlabTemplateFiles(userId, id.slice(GITLAB_PREFIX.length))
    : localTemplateFiles(id);
  return applyPlaceholders(files, vars);
}
