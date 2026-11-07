import { createRequire } from 'node:module';
import type { CatalogClass } from '../catalog.js';
import { packageSource } from './build.js';

/**
 * The venue classes a browser can typeset, in the shape the compiler's
 * GET /catalog answers: the compiler's own allowlist (apps/compiler/catalog.js),
 * filtered by what TeX Live's package database carries, since every TeX Live
 * file reaches the browser on demand. No class ships a sample here (that would
 * mean unpacking its documentation), so each venue gets the skeleton
 * catalog.ts builds. Empty when on-demand packages are off: the profile alone
 * is then all a browser has.
 */
interface Venue { id: string; pkg: string; files: string[] }

export async function browserCatalog(): Promise<CatalogClass[]> {
  const source = packageSource();
  if (!source) return [];
  const { VENUES } = createRequire(import.meta.url)('../../../compiler/catalog.js') as { VENUES: Venue[] };
  const found = await source.locateFiles(VENUES.flatMap((v) => v.files));
  const classes: CatalogClass[] = [];
  for (const v of VENUES) {
    const file = v.files.find((f) => found.has(f));
    if (!file) continue;
    const hit = found.get(file)!;
    classes.push({
      id: v.id,
      cls: file.replace(/\.(cls|sty)$/i, ''),
      kind: /\.sty$/i.test(file) ? 'style' : 'class',
      pkg: v.pkg,
      license: hit.license,
      version: hit.version,
      source: hit.home,
      sample: null,
    });
  }
  return classes;
}
