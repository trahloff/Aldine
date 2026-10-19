import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

// AGPL section 13 obliges a network instance to offer its users the source of
// the version they are talking to, so the build stamps in what it was built
// from. Builds outside a git checkout (release tarball, Docker context without
// .git) fall back to the version alone rather than failing.
function gitRev(): string {
  if (process.env.ALDINE_BUILD_REV) return process.env.ALDINE_BUILD_REV;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// pdf.js loads CMaps at runtime to map CJK CID-font glyphs (PdfPane passes
// cMapUrl/cMapPacked). Without these files reachable, every CJK character in
// the preview renders as blank space while Latin and math still work. The
// build ships them at <base>/cmaps/ — one level above the worker's assets/,
// which is where PdfPane derives cMapUrl from. Dev needs nothing: Vite's
// workerSrc is the package's own build/ dir under /@fs, so ../cmaps/ lands
// on the shipped pdfjs-dist cmaps directly.
function pdfjsCmaps(): Plugin {
  const cmapsDir = join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'cmaps',
  );
  return {
    name: 'pdfjs-cmaps-build',
    apply: 'build',
    generateBundle() {
      for (const f of readdirSync(cmapsDir)) {
        if (!f.endsWith('.bcmap')) continue;
        this.emitFile({ type: 'asset', fileName: `cmaps/${f}`, source: readFileSync(join(cmapsDir, f)) });
      }
    },
  };
}

export default defineConfig({
  // Relative base: chunk and asset URLs resolve from the loading script's own
  // URL, so one build serves at the root or under ALDINE_BASE_PATH. The server
  // pins index.html's own references to the base path when it serves it.
  base: './',
  define: {
    __ALDINE_VERSION__: JSON.stringify(pkg.version),
    __ALDINE_REV__: JSON.stringify(gitRev()),
  },
  plugins: [react(), pdfjsCmaps()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/plugins': 'http://localhost:3000',
      '/oauth/token': 'http://localhost:3000',
      '/oauth/register': 'http://localhost:3000',
      '/oauth/revoke': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
      '/collab': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
});
