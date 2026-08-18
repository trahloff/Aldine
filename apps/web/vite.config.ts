import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

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

export default defineConfig({
  define: {
    __ALDINE_VERSION__: JSON.stringify(pkg.version),
    __ALDINE_REV__: JSON.stringify(gitRev()),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/plugins': 'http://localhost:3000',
      '/collab': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
});
