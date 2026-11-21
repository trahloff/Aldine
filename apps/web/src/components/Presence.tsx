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

const jumpLabel = (r: PresenceRow) => (r.file || r.here ? `Go to ${r.name}’s cursor${r.here ? '' : ` in ${r.file}`}` : `${nameOf(r)}, in no file`);

function Avatar({ r, onJump }: { r: PresenceRow; onJump(r: PresenceRow): void }) {
  const canJump = r.here || !!r.file;
  const title = `${nameOf(r)}, ${whereOf(r)}`;
  const common = {
    type: 'button' as const, title, 'aria-label': canJump ? `${jumpLabel(r)} (${whereOf(r)})` : title, disabled: !canJump,
    onClick: () => onJump(r), 'data-here': r.here ? 'true' : 'false', 'data-file': r.file ?? '',
  };
  // The theme token, not the awareness colour, for agents: the server
  // broadcasts one violet for both themes and the light one needs a deeper grade.
  return r.isAgent ? (
    <button className="presence__avatar presence__avatar--agent" style={{ background: 'var(--agent)' }} data-testid="presence-agent" {...common}>
      <span aria-hidden="true" style={{ display: 'contents' }}><IconSpark /></span>
    </button>
  ) : (
    <button className={`presence__avatar${r.here ? '' : ' presence__avatar--elsewhere'}`} style={{ background: r.color }} data-testid="presence-user" data-name={r.name} {...common}>
      <AvatarFace avatar={r.avatar}>{initials(r.name)}</AvatarFace>
    </button>
  );
}

const SHOWN = 5;

/**
 * Who else is here: on the open file first, then in the branch's other
 * files, dimmed. Choosing a person scrolls to their cursor, opening their
 * file first when it is another one; past five people the rest are in a list.
 */
export default function Presence({ rows, onJump }: { rows: PresenceRow[]; onJump(r: PresenceRow): void }) {
  if (!rows.length) return null;
  const summary = rows.map((r) => `${nameOf(r)} (${whereOf(r)})`).join(', ');
  const items = (): MenuEntry[] => rows.map((r, i): MenuEntry => ({
    id: `p${i}`, label: `${nameOf(r)}, ${whereOf(r)}`, onSelect: () => onJump(r), disabled: !r.here && !r.file, testId: 'presence-row',
  }));
  return (
    <div className="presence" role="group" aria-label={`People here: ${summary}`} title={summary} data-testid="presence">
      {rows.slice(0, SHOWN).map((r, i) => <Avatar key={i} r={r} onJump={onJump} />)}
      {rows.length > SHOWN && (
        <MenuButton items={items} label="People in this project" ariaLabel={`Everyone here: ${summary}`} title={summary}
          className="presence__avatar presence__more" testId="presence-more" menuTestId="presence-menu" placement="bottom-end" sheetTitle="People here">
          +{rows.length - SHOWN}
        </MenuButton>
      )}
    </div>
  );
}
