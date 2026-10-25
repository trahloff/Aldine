/**
 * Web storage that never throws. Reading `window.localStorage` itself throws
 * when the browser blocks site data, Safari's private windows used to throw
 * on every write, and a full quota throws on setItem. A preference that
 * cannot be read falls back to its default and one that cannot be written
 * lasts for this page only; neither may take the page down.
 */
export interface SafeStore {
  get(key: string): string | null;
  /** False when the value could not be stored. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** A JSON value, or `fallback` when it is missing, unreadable or fails `valid`. */
  getJSON<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T;
  setJSON(key: string, value: unknown): boolean;
}

export function makeSafeStore(open: () => Storage | null | undefined): SafeStore {
  const store = (): Storage | null => {
    try { return open() ?? null; } catch { return null; }
  };
  const get = (key: string): string | null => {
    try { return store()?.getItem(key) ?? null; } catch { return null; }
  };
  const set = (key: string, value: string): boolean => {
    try {
      const s = store();
      if (!s) return false;
      s.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  return {
    get,
    set,
    remove(key) {
      try { store()?.removeItem(key); } catch { /* nothing stored to remove */ }
    },
    getJSON<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T {
      const raw = get(key);
      if (raw === null) return fallback;
      try {
        const v: unknown = JSON.parse(raw);
        if (valid) return valid(v) ? v : fallback;
        return v as T;
      } catch {
        return fallback;
      }
    },
    setJSON(key, value) {
      return set(key, JSON.stringify(value));
    },
  };
}

const win = (): (Window & typeof globalThis) | undefined => (typeof window === 'undefined' ? undefined : window);

/** localStorage: preferences kept by this browser. */
export const safeStorage: SafeStore = makeSafeStore(() => win()?.localStorage);

/** sessionStorage: state for this tab only. */
export const safeSession: SafeStore = makeSafeStore(() => win()?.sessionStorage);
