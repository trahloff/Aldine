import { forgetInviteResume, rememberInviteResume } from './invites';
import { forgetOAuthResume, rememberOAuthResume } from './oauthParams';
import { forgetProjectResume, rememberProjectResume } from './projectResume';
import { safeSession, type SafeStore } from './safeStorage';

// What each sign-in screen does as a sign-in starts on it. Only the page it
// started on may bring it back after an SSO provider: whatever another page
// left behind belongs to a sign-in that was abandoned.

/** On the invitation page `id`. */
export function inviteSignInStarts(id: string, store: SafeStore = safeSession, now = Date.now()): void {
  forgetOAuthResume(store);
  forgetProjectResume(store);
  rememberInviteResume(id, store, now);
}

/** On the consent page for the authorize request `search` (its query string). */
export function consentSignInStarts(search: string, store: SafeStore = safeSession, now = Date.now()): void {
  forgetInviteResume(store);
  forgetProjectResume(store);
  rememberOAuthResume(search, store, now);
}

/** On the app's own sign-in screen, shown in place of project `id`'s page. */
export function projectSignInStarts(id: string, store: SafeStore = safeSession, now = Date.now()): void {
  forgetInviteResume(store);
  forgetOAuthResume(store);
  rememberProjectResume(id, store, now);
}

/** On the app's own sign-in screen. */
export function appSignInStarts(store: SafeStore = safeSession): void {
  forgetInviteResume(store);
  forgetOAuthResume(store);
  forgetProjectResume(store);
}
