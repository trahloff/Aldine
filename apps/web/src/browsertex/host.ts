import { withBase } from '../basePath';
import { setBrowserTexHints } from '../editor/errorHints';

/**
 * The page's side of the TeX worker (worker.ts): starts it once per tab,
 * reports the first download's progress, runs one typeset at a time, and
 * ends a typeset by ending the worker (TeX cannot be interrupted mid-run;
 * the next typeset starts a fresh one from the browser's cache).
 */

/** GET /api/typeset in browser mode; a server without it typesets itself. */
export interface TypesetInfo {
  mode: 'browser';
  assets: { base: string; version: string; texlive: string; profile: string; bundle: string; biber: boolean; bytes: number };
  /** Where missing TeX Live files are fetched from, when the server offers it. */
  packages?: { endpoint: string };
  state: 'ready' | 'downloading' | 'failed';
  done?: number;
  total?: number;
  error?: string;
}

export interface EngineOutput {
  exitCode: number;
  pdf: Uint8Array | null;
  synctex: Uint8Array | null;
  log: string;
  blg: string;
  transcript: string;
}

export type EngineStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; loaded: number; total: number }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string };

let status: EngineStatus = { phase: 'idle' };
const listeners = new Set<(s: EngineStatus) => void>();
function setStatus(s: EngineStatus) {
  status = s;
  for (const fn of listeners) fn(s);
}
export function engineStatus(): EngineStatus { return status; }
export function onEngineStatus(fn: (s: EngineStatus) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let infoPromise: Promise<TypesetInfo | null> | null = null;
/** The last answer that named a build: a page that has seen one never takes
 *  a failed request for a server that typesets itself. */
let lastInfo: TypesetInfo | null = null;
const ASK_TRIES = 3;

async function askTypeset(): Promise<TypesetInfo | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(withBase('/api/typeset'));
      // The route exists only in browser mode.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status} when asked how it typesets`);
      lastInfo = (await res.json()) as TypesetInfo;
      return lastInfo;
    } catch (err) {
      if (lastInfo) return lastInfo;
      if (attempt >= ASK_TRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** The server's browser TeX build, or null when the server typesets. Kept
 *  once the build is ready, or once the server says it has none; asked again
 *  while the server is still preparing it. Rejects when the server cannot be
 *  asked at all, rather than guessing a mode. */
export function typesetInfo(): Promise<TypesetInfo | null> {
  infoPromise ??= askTypeset().then((info) => {
    setBrowserTexHints(!!info);
    if (info && info.state !== 'ready') infoPromise = null;
    return info;
  }, (err) => {
    infoPromise = null;
    throw err;
  });
  return infoPromise;
}

const SERVER_POLL_MS = 3000;

/** The build once the server has it: right after a boot it is still being
 *  checked or downloaded, and its files answer 503 until then. */
async function readyInfo(info: TypesetInfo): Promise<TypesetInfo> {
  let cur: TypesetInfo | null = info;
  while (cur && cur.state !== 'ready') {
    if (cur.state === 'failed') throw new Error(cur.error || 'The server could not prepare TeX for the browser');
    setStatus({ phase: 'loading', loaded: 0, total: cur.assets.bytes });
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
    cur = await typesetInfo();
  }
  if (!cur) throw new Error('The server no longer typesets in the browser');
  return cur;
}

const PREF_KEY = 'aldine.browserTex';

/** This person's choice for this browser: 'on', 'off', or null (decided by the device). */
export function typesetHerePreference(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function setTypesetHerePreference(v: 'on' | 'off' | null): void {
  try { if (v) localStorage.setItem(PREF_KEY, v); else localStorage.removeItem(PREF_KEY); } catch { /* private mode: this tab only */ }
}

/**
 * Whether this device should download TeX (hundreds of megabytes, then a
 * heavy worker): not a phone unless its owner says so; phones follow the
 * PDFs other tabs publish. navigator.deviceMemory is no guide here: Chromium
 * reports different values for the same machine from one launch to the next.
 */
export function deviceWantsTex(): boolean {
  const pref = typesetHerePreference();
  if (pref) return pref === 'on';
  return !matchMedia('(pointer: coarse) and (max-width: 820px)').matches;
}

/** Whether this tab typesets in this browser: the server hands out TeX and
 *  the device wants it. An engine that failed to start is started again by
 *  the next typeset, whose error says why when it fails again. */
export async function typesetsHere(): Promise<boolean> {
  return !!(await typesetInfo()) && deviceWantsTex();
}

interface Running { id: number; resolve: (o: EngineOutput) => void; reject: (e: Error) => void }

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let running: Running | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();

function start(given: TypesetInfo): Promise<void> {
  if (ready) return ready;
  ready = readyInfo(given).then((info) => boot(info));
  ready.catch((err) => {
    ready = null;
    setStatus({ phase: 'failed', error: err.message });
  });
  return ready;
}

function boot(info: TypesetInfo): Promise<void> {
  const w = new Worker(new URL('./worker.ts', import.meta.url));
  worker = w;
  setStatus({ phase: 'loading', loaded: 0, total: info.assets.bytes });
  const booted = new Promise<void>((resolve, reject) => {
    w.onmessage = ({ data }) => {
      const run = running;
      if (data.type === 'progress') setStatus({ phase: 'loading', loaded: data.loaded, total: data.total });
      else if (data.type === 'ready') { setStatus({ phase: 'ready' }); resolve(); }
      else if (data.type === 'result' && run && run.id === data.id) { running = null; run.resolve(data as EngineOutput); }
      else if (data.type === 'error') {
        const err = new Error(data.message);
        if (run && run.id === data.id) { running = null; run.reject(err); }
        else { setStatus({ phase: 'failed', error: data.message }); reject(err); }
      }
    };
    w.onerror = (e) => {
      e.preventDefault();
      const err = new Error(e.message || 'The TeX engine stopped unexpectedly');
      if (running) { running.reject(err); running = null; }
      setStatus({ phase: 'failed', error: err.message });
      reject(err);
      stopEngine();
    };
  });
  const base = new URL(info.assets.base, location.href).toString();
  w.postMessage({ type: 'init', base, bundle: info.assets.bundle, biber: info.assets.biber });
  return booted;
}

/** Downloads (or loads from the browser's cache) and starts TeX, once per tab. */
export async function warmEngine(): Promise<void> {
  const info = await typesetInfo();
  if (info && deviceWantsTex()) await start(info).catch(() => { /* status says so */ });
}

/** Ends the engine and whatever it is typesetting. */
export function stopEngine(): void {
  worker?.terminate();
  worker = null;
  ready = null;
  if (running) { running.reject(Object.assign(new Error('Typesetting stopped'), { stopped: true })); running = null; }
  if (status.phase !== 'failed') setStatus({ phase: 'idle' });
}

export interface EngineJob {
  files: Array<{ path: string; contents: Uint8Array | string }>;
  main: string;
  engine: string;
  draft: boolean;
}

export function runEngine(info: TypesetInfo, job: EngineJob): Promise<EngineOutput> {
  const run = queue.then(async () => {
    await start(info);
    return new Promise<EngineOutput>((resolve, reject) => {
      const id = nextId++;
      running = { id, resolve, reject };
      const endpoint = info.packages ? new URL(info.packages.endpoint, location.href).toString() : '';
      worker!.postMessage({ type: 'compile', id, ...job, endpoint });
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
