'use strict';
/**
 * Which relative paths the runner accepts, in either direction (RUNNER.md,
 * D8). The app applies the same rules again to everything it gets back.
 */
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;
const MAX_DEPTH = 32;

// C0/C1 controls and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Bidirectional controls and the default-ignorable code points: invisible
// characters some filesystems drop, so "‌.git" would name ".git".
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;

/** null when `rel` may cross, else why not. */
function pathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (Buffer.byteLength(rel) > MAX_PATH_BYTES) return 'path too long';
  if (rel.includes('�')) return 'name is not valid UTF-8';
  if (rel.normalize('NFC') !== rel) return 'name is not in Unicode normal form C';
  if (CONTROL.test(rel)) return 'name contains a control character';
  if (INVISIBLE.test(rel)) return 'name contains an invisible or direction character';
  if (rel.includes('\\') || rel.includes(':')) return 'name contains \\ or :';
  const parts = rel.split('/');
  if (parts.length > MAX_DEPTH) return 'folders nested too deep';
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return 'not a plain relative path';
    if (Buffer.byteLength(seg) > MAX_NAME_BYTES) return 'name too long';
    if (seg.startsWith('.')) return 'hidden names (starting with ".") are not copied';
    if (seg.startsWith('-')) return 'names starting with "-" are not copied';
    if (seg === '__pycache__') return 'Python caches are not copied';
  }
  return null;
}

/** A directory the collector does not enter at all. */
const skippedDir = (name) => name.startsWith('.') || name === '__pycache__';

/** The same name for case-insensitive and normalising filesystems. */
const foldKey = (rel) => rel.normalize('NFKC').toLowerCase();

module.exports = { pathProblem, skippedDir, foldKey, MAX_DEPTH };
