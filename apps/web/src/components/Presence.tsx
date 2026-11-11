import { IconSpark } from './Icons';
import { initials } from '../util/homeList';
import { AvatarFace } from './AvatarFace';
import { MenuButton, type MenuEntry } from './Menu';
import type { PresenceRow } from '../util/presence';

export interface PresenceUser {
  name: string;
  color: string;
  /** "<account id>/<version>" of the person's profile picture (api.avatarSrc). */
  avatar?: string;
  /** Agent (MCP) sessions — rendered with a glyph avatar, never an initial. */
  isAgent?: boolean;
  /** First time this client saw the agent's awareness state (epoch ms). */
  startedAt?: number;
}

/** The name may carry its own parentheses: "Claude (for Ada)". */
function agentTitle(u: PresenceUser): string {
  if (!u.startedAt) return `${u.name}, agent`;
  const d = new Date(u.startedAt);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${u.name}, agent session started ${hhmm}`;
}

/** Where a row's person is, in words. */
const whereOf = (r: PresenceRow) => (r.here ? 'in this file' : r.file ? `in ${r.file}` : 'in no file');
const nameOf = (r: PresenceRow) => (r.isAgent ? agentTitle(r) : r.name);

function Avatar({ r }: { r: PresenceRow }) {
  const title = `${nameOf(r)}, ${whereOf(r)}`;
  const common = { title, 'data-here': r.here ? 'true' : 'false', 'data-file': r.file ?? '' };
  // The theme token, not the awareness colour, for agents: the server
  // broadcasts one violet for both themes and the light one needs a deeper grade.
  return r.isAgent ? (
    <span className="presence__avatar presence__avatar--agent" style={{ background: 'var(--agent)' }} data-testid="presence-agent" {...common}>
      <span aria-hidden="true" style={{ display: 'contents' }}><IconSpark /></span>
    </span>
  ) : (
    <span className={`presence__avatar${r.here ? '' : ' presence__avatar--elsewhere'}`} style={{ background: r.color }} data-testid="presence-user" data-name={r.name} {...common}>
      <AvatarFace avatar={r.avatar}>{initials(r.name)}</AvatarFace>
    </span>
  );
}

/**
 * Who else is here: on the open file first, then in the branch's other
 * files, dimmed. The chip opens a list with everyone's file; choosing one
 * opens that file.
 */
export default function Presence({ rows, onOpenFile }: { rows: PresenceRow[]; onOpenFile(path: string): void }) {
  if (!rows.length) return null;
  const summary = rows.map((r) => `${nameOf(r)} (${whereOf(r)})`).join(', ');
  const items = (): MenuEntry[] => rows.map((r, i): MenuEntry => (r.here || !r.file
    ? { id: `p${i}`, label: `${nameOf(r)}, ${whereOf(r)}`, onSelect: () => {}, disabled: true, testId: 'presence-row' }
    : { id: `p${i}`, label: `${nameOf(r)}, ${whereOf(r)}`, onSelect: () => onOpenFile(r.file!), testId: 'presence-row' }));
  return (
    <MenuButton items={items} label="People in this project" ariaLabel={`People here: ${summary}`} title={summary}
      className="presence" testId="presence" menuTestId="presence-menu" placement="bottom-end" sheetTitle="People here">
      {rows.slice(0, 5).map((r, i) => <Avatar key={i} r={r} />)}
      {rows.length > 5 && <span className="presence__avatar" style={{ background: 'var(--text-3)' }}>+{rows.length - 5}</span>}
    </MenuButton>
  );
}
