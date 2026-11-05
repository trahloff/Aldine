import { safeSession, type SafeStore } from './safeStorage';
import { takeResume, writeResume } from './signInResume';

/** Where a sign-in started on a project's page (a session that ended there)
 *  returns after an SSO provider, whose callback always lands on "/". */
export const PROJECT_RESUME_KEY = 'aldine.project.resume';
/** A project page of this app, relative: nothing stored here can lead off the
 *  app or elsewhere in it. */
const PROJECT_PATH_RE = /^\/p\/[A-Za-z0-9_-]{1,64}$/;

/** The project an app path (without the base path) opens, or null. */
export function projectOfPath(path: string): string | null {
  return PROJECT_PATH_RE.test(path) ? path.slice('/p/'.length) : null;
}

/** A sign-in starts on the page of project `id`: bring it back there. */
export function rememberProjectResume(id: string, store: SafeStore = safeSession, now = Date.now()): void {
  writeResume(store, PROJECT_RESUME_KEY, `/p/${id}`, PROJECT_PATH_RE, now);
}

/** The project opened, or a sign-in starts elsewhere: nothing to come back to. */
export function forgetProjectResume(store: SafeStore = safeSession): void {
  store.remove(PROJECT_RESUME_KEY);
}

/** The project page to return to after signing in, once, and only within
 *  RESUME_MAX_AGE_MS of the sign-in starting there. */
export function takeProjectResume(store: SafeStore = safeSession, now = Date.now()): string | null {
  return takeResume(store, PROJECT_RESUME_KEY, PROJECT_PATH_RE, now);
}
