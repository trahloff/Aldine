import { AUTH_ENABLED, pub } from './auth.js';
import { roleOf } from './authz.js';
import { db } from './db/index.js';
import type { Comment, ProjectMeta, User } from './db/types.js';
import { isOrcidId } from './invites.js';
import { isGuestId, linksOf } from './sharelinks.js';

/**
 * The people a review comment can @mention or be assigned to: every account
 * that can open the project now. That is the owner, the accounts its share
 * entries name, the accounts that came in through a share link, and anyone
 * who already wrote in a thread (a visitor of the project's address link is
 * recorded nowhere else). Guests have no account to notify, so never.
 * Names only: the share entries are the owner's private list of addresses.
 */
export interface Person { id: string; name: string }

const MAX_PEOPLE = 500;

async function accountFor(entry: string): Promise<User | null> {
  if (isOrcidId(entry)) return db().findUserBySubject(`orcid:${entry.toUpperCase()}`);
  return db().findUserByEmail(entry.toLowerCase());
}

export async function projectPeople(meta: ProjectMeta, threads?: Comment[]): Promise<Person[]> {
  if (!AUTH_ENABLED || !meta.ownerId) return [];
  const ids = new Set<string>([meta.ownerId]);
  for (const l of linksOf(meta)) for (const m of l.members ?? []) if (!isGuestId(m.id)) ids.add(m.id);
  for (const c of threads ?? await db().loadComments(meta.id)) {
    if (c.authorId) ids.add(c.authorId);
    for (const r of c.replies) if (r.authorId) ids.add(r.authorId);
  }
  const users = new Map<string, User>();
  for (const entry of meta.share?.collaborators ?? []) {
    const u = await accountFor(entry).catch(() => null);
    if (u) users.set(u.id, u);
  }
  for (const id of ids) {
    if (users.has(id) || isGuestId(id)) continue;
    const u = await db().getUser(id).catch(() => null);
    if (u) users.set(u.id, u);
  }
  const people: Person[] = [];
  for (const u of users.values()) {
    if (u.disabledAt || roleOf(meta, pub(u)) === null) continue;
    people.push({ id: u.id, name: u.name || 'Unnamed' });
    if (people.length >= MAX_PEOPLE) break;
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does `text` carry `@name` as a whole name (not "@Al" inside "@Alice")? */
export const carriesMention = (text: string, name: string) => new RegExp(`@${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/** The ids in `requested` that name one of `people` and whose `@Name` the
 *  text still carries, in order, at most `max`. */
export function mentionedIn(text: string, requested: unknown, people: Person[], max = 20): string[] {
  if (!Array.isArray(requested)) return [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const out: string[] = [];
  for (const id of requested) {
    const p = typeof id === 'string' ? byId.get(id) : undefined;
    if (!p || out.includes(p.id) || !carriesMention(text, p.name)) continue;
    out.push(p.id);
    if (out.length >= max) break;
  }
  return out;
}
