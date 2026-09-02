import { IconSpark } from './Icons';

export interface PresenceUser {
  name: string;
  color: string;
  /** Agent (MCP) sessions — rendered with a glyph avatar, never an initial. */
  isAgent?: boolean;
  /** First time this client saw the agent's awareness state (epoch ms). */
  startedAt?: number;
}

function agentTitle(u: PresenceUser): string {
  if (!u.startedAt) return `${u.name} (agent)`;
  const d = new Date(u.startedAt);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${u.name} (agent session started ${hhmm})`;
}

export default function Presence({ users }: { users: PresenceUser[] }) {
  if (users.length <= 1) return null;
  return (
    <div className="presence" title={users.map((u) => u.name).join(', ')} data-testid="presence">
      {users.slice(0, 5).map((u, i) => (
        u.isAgent ? (
          <span key={i} className="presence__avatar presence__avatar--agent" title={agentTitle(u)} aria-label={agentTitle(u)} style={{ background: u.color }} data-testid="presence-agent">
            <IconSpark />
          </span>
        ) : (
          <span key={i} className="presence__avatar" title={u.name} aria-label={u.name} style={{ background: u.color }}>
            {u.name.trim().slice(0, 1).toUpperCase()}
          </span>
        )
      ))}
      {users.length > 5 && <span className="presence__avatar" style={{ background: 'var(--text-3)' }}>+{users.length - 5}</span>}
    </div>
  );
}
