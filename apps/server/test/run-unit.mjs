// Runs every test/*.test.mjs, each in its own process, in name order.
//
// The list is discovered rather than written into package.json: when two
// branches each added a test file, the single "test:unit" line conflicted and
// whoever resolved it kept one side's files. CI stayed green with fewer tests
// and nothing reported the loss. Integration and conformance suites use other
// suffixes on purpose (they need a network or a database) and are not run here.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
if (files.length === 0) {
  console.error('run-unit: no *.test.mjs files found in', dir);
  process.exit(1);
}
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));

const failed = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  const r = spawnSync(process.execPath, [tsx, path.join(dir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(file);
}
console.log(`\nrun-unit: ${files.length - failed.length}/${files.length} files passed`);
if (failed.length) {
  console.error('run-unit: failed:', failed.join(', '));
  process.exit(1);
}
