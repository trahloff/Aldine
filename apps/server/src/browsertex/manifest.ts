import fs from 'node:fs';

/**
 * Which build of TeX for the browser the server hands out, and where it comes
 * from. The server treats every file as opaque bytes checked against its
 * sha256; only apps/web/src/browsertex/ knows what the files do. Pointing
 * ALDINE_BROWSER_TEX_MANIFEST at another JSON file of this shape swaps the
 * build (a newer release, a mirror, a self-built one) without a code change.
 */
export interface BrowserTexManifest {
  /** Names the build in served URLs, so it must change whenever a file does:
   *  browsers cache everything under it as immutable. */
  version: string;
  /** TeX Live release of the build; on-demand packages must come from the same one. */
  texlive: string;
  /** Files are fetched from baseUrl + name. */
  baseUrl: string;
  files: Record<string, { sha256: string; size: number; url?: string }>;
  /** Always served. */
  core: string[];
  /** Cumulative TeX Live bundles: exactly one is served, its .js first. */
  profiles: Record<string, string[]>;
  /** Served unless ALDINE_BROWSER_TEX_BIBER=0. */
  biber: string[];
  /** License texts that go wherever the binaries go. */
  licenses: string[];
}

const RELEASE = 'build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1';
const COMMIT = '46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86';

export const DEFAULT_MANIFEST: BrowserTexManifest = {
  version: 'texlyre-2026-46ebb62',
  texlive: '2026',
  baseUrl: `https://github.com/TeXlyre/texlyre-busytex-build/releases/download/${RELEASE}/`,
  files: {
    'busytex_worker.js': { sha256: '80eca56a2eb015bdfbebff26e539dd793407b73b6c1cd351170e6fdb6e17c39a', size: 3123 },
    'busytex_pipeline.js': { sha256: '4855e8fec24e8df952e1080d902791752bcdf283f4fae15811c371dd3ba3389e', size: 36266 },
    'busytex_biber.js': { sha256: 'e1a3ff55a120e392d3a7ef27f1bff1978c7a9d5978999296e39e1cfeac01d923', size: 3688 },
    'busytex.js': { sha256: '875b87795162cb26b15bd93cffa2e8739bcb900d623ab904029b39402508a1a4', size: 271047 },
    'busytex.wasm': { sha256: '8d1988fc58cd1611c3cbd6bd986c3e607e5ff44f1d94252207ff7aae4cee72e0', size: 32507525 },
    'texlive-basic.js': { sha256: 'd4abc2e93a1ae33099107c6ad8a61813978cd44036a95697db2f2365a393c283', size: 2091651 },
    'texlive-basic.data': { sha256: 'ccb35d98d77cbaf988e1481f8538709f72166196785cf6b8785eabe6c8fb2993', size: 92785062 },
    'texlive-recommended.js': { sha256: '4354ad2040462400ca856e595cec970509c95f8d2ac87fb3e06e0e17ffc9033a', size: 3929114 },
    'texlive-recommended.data': { sha256: '7a912aa15f9e534b1948566771bf2510ca704fab3c3fdece7f75bc6558525a92', size: 201197697 },
    'texlive-extra.js': { sha256: '6c935b358ababde879aa2c62b48601d6e6be4ee7f3f9ed86c7f49136b803d618', size: 7345232 },
    'texlive-extra.data': { sha256: '9ae117b8fd7eacc13430296278d63603070f083c6f1e647937a6866874c726ae', size: 341568560 },
    'biber.js': { sha256: 'f097b241ec1dfaff8c43b7c3e242a85c535d4a24b6252288da869d1a8b465c08', size: 1069103 },
    'biber.wasm': { sha256: '6c2ddccf3b95e06b419d4aee5f88ef10ddec658ce760fabb34d7145371ff18c5', size: 9644474 },
    'biber.data': { sha256: '9ea1357e6180477479b5edfe17538ba655ebebc03142a195d85fb1d47899df21', size: 21079910 },
    'LICENSE': { sha256: '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef', size: 34523, url: `https://raw.githubusercontent.com/TeXlyre/texlyre-busytex-build/${COMMIT}/LICENSE` },
    'NOTICE': { sha256: '984c51c84d462e27d93386f65a07c4e7177f18a1b2f9c8d8c4b2f343e89f0c56', size: 467, url: `https://raw.githubusercontent.com/TeXlyre/texlyre-busytex-build/${COMMIT}/NOTICE` },
  },
  core: ['busytex_worker.js', 'busytex_pipeline.js', 'busytex_biber.js', 'busytex.js', 'busytex.wasm'],
  profiles: {
    basic: ['texlive-basic.js', 'texlive-basic.data'],
    recommended: ['texlive-recommended.js', 'texlive-recommended.data'],
    extra: ['texlive-extra.js', 'texlive-extra.data'],
  },
  biber: ['biber.js', 'biber.wasm', 'biber.data'],
  licenses: ['LICENSE', 'NOTICE'],
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws on a manifest the server could not serve safely: every listed name
 *  becomes a file name on disk and a URL segment. */
export function validateManifest(m: BrowserTexManifest): BrowserTexManifest {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  if (typeof m.version !== 'string' || !SAFE_NAME.test(m.version)) throw new Error('manifest version must be a plain name');
  if (typeof m.baseUrl !== 'string' || !/^https?:\/\//.test(m.baseUrl)) throw new Error('manifest baseUrl must be an http(s) URL');
  for (const [name, f] of Object.entries(m.files ?? {})) {
    if (!SAFE_NAME.test(name)) throw new Error(`manifest file name ${JSON.stringify(name)} is not a plain name`);
    if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? '')) throw new Error(`manifest file ${name} has no sha256`);
  }
  const listed = [...m.core, ...Object.values(m.profiles).flat(), ...m.biber, ...m.licenses];
  for (const name of listed) if (!m.files[name]) throw new Error(`manifest lists ${name} without its checksum`);
  for (const [profile, names] of Object.entries(m.profiles)) {
    if (!names[0]?.endsWith('.js')) throw new Error(`manifest profile ${profile} must start with its .js`);
  }
  return m;
}

/** The manifest named by ALDINE_BROWSER_TEX_MANIFEST (a JSON file path), else the pinned default. */
export function loadManifest(file = process.env.ALDINE_BROWSER_TEX_MANIFEST): BrowserTexManifest {
  if (!file) return DEFAULT_MANIFEST;
  return validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')) as BrowserTexManifest);
}

/** Files one deployment serves: core, one profile, biber unless turned off, licenses. */
export function selectedFiles(m: BrowserTexManifest, profile: string, biber: boolean): string[] {
  const bundle = m.profiles[profile];
  if (!bundle) throw new Error(`ALDINE_BROWSER_TEX_PROFILE=${profile} is not one of ${Object.keys(m.profiles).join(', ')}`);
  return [...m.core, ...bundle, ...(biber ? m.biber : []), ...m.licenses];
}
