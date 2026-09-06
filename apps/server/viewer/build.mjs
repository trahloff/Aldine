// Builds the MCP App viewer (spec docs/plans/agent-api/04-phase3-pdf-app.md §3.2)
// into ONE self-contained HTML file: the sandbox CSP allows no external
// origins, so pdf.js (display + worker) and the ext-apps bridge are bundled
// and inlined, and CSS lives in a <style> block. Output:
// apps/server/assets/pdf-viewer.html (served as ui://aldine/pdf-viewer).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', 'assets', 'pdf-viewer.html');
/** Hosts fetch the resource on every conversation; keep it well under this. */
const SIZE_BUDGET = 2.5 * 1024 * 1024;

const result = await build({
  entryPoints: [path.join(here, 'src', 'main.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022', 'safari17'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});
let js = result.outputFiles[0].text;
// The bundle is inlined into <script>: the HTML parser must never see a
// closing script tag or comment opener inside it.
js = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const css = fs.readFileSync(path.join(here, 'src', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8')
  .replace('/*__STYLE__*/', () => css.replace(/<\/style/gi, '<\\/style'))
  .replace('/*__SCRIPT__*/', () => js);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const size = Buffer.byteLength(html);
console.log(`viewer: ${path.relative(process.cwd(), out)} ${(size / 1024 / 1024).toFixed(2)} MB`);
if (size > SIZE_BUDGET) {
  console.error(`viewer: ${size} bytes exceeds the ${SIZE_BUDGET} byte budget`);
  process.exit(1);
}
