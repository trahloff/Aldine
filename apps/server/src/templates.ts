import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface TemplateInfo { id: string; name: string; description?: string; icon?: string; order?: number }

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
    const metaPath = path.join(dir, name, 'template.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TemplateInfo;
      meta.id = meta.id || name;
      // The built-in id is taken: a directory claiming it would list twice and
      // could never be created (templateFiles answers {} for it).
      if (meta.id === BLANK_TEMPLATE.id) {
        console.warn(`templates/${name} uses the built-in template id "${BLANK_TEMPLATE.id}" and is ignored`);
        continue;
      }
      out.push(meta);
    } catch { /* skip broken template */ }
  }
  return [BLANK_TEMPLATE, ...out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99))];
}

/** All files of a template (except template.json), as relative-path → content. */
export function templateFiles(id: string): Record<string, string> {
  if (id === BLANK_TEMPLATE.id) return {};
  if (id.includes('..') || id.includes('/')) throw new Error('bad template id');
  const base = path.join(config.templatesDir, id);
  if (!fs.existsSync(path.join(base, 'template.json'))) throw new Error(`unknown template: ${id}`);
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else if (relPath !== 'template.json') files[relPath] = fs.readFileSync(path.join(base, relPath), 'utf8');
    }
  };
  walk('');
  return files;
}
