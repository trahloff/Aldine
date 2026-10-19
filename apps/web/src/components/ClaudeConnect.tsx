import { useState } from 'react';
import { withBase } from '../basePath';
import { useAuth } from './Auth';
import { useToast } from './Toast';
import Modal from './Modal';

/** claude.ai calls the instance from Anthropic's cloud: plain http, loopback,
 *  RFC 1918 ranges and .local names never resolve from there. Claude Code
 *  (on the user's machine) reaches them fine. */
export function unreachableFromCloud(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return true;
    const h = u.hostname;
    return h === 'localhost' || /\.local$/i.test(h) || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h === '[::1]';
  } catch { return true; }
}

type Client = 'cloud' | 'code';

/** The address Claude is given: ALDINE_PUBLIC_URL when the server has one
 *  (what its OAuth metadata names too), else the address this page came from. */
export function useConnectorUrl(): string {
  const { publicUrl } = useAuth();
  return publicUrl ? `${publicUrl.replace(/\/+$/, '')}/mcp` : `${location.origin}${withBase('/mcp')}`;
}

/** How to add this instance to Claude: claude.ai (and Desktop and Cowork,
 *  which use the same connectors) or Claude Code. With auth on, Connect signs
 *  in and asks for the project scope; with auth off the instance has one
 *  static token, which only the operator knows, so it is named, never shown. */
export function ClaudeConnectSteps({ compact = false }: { compact?: boolean }) {
  const { mcpEnabled, authEnabled } = useAuth();
  const toast = useToast();
  const connectorUrl = useConnectorUrl();
  const cloudBlocked = unreachableFromCloud(connectorUrl);
  const [client, setClient] = useState<Client>(cloudBlocked ? 'code' : 'cloud');
  const header = authEnabled ? '' : ' --header "X-Aldine-Token: <ALDINE_MCP_TOKEN>"';
  const command = `claude mcp add --transport http aldine ${connectorUrl}${header}`;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, 'ok');
    } catch {
      toast(`Could not copy the ${label.toLowerCase()}. Select it and copy it by hand.`, 'error');
    }
  };

  if (!mcpEnabled) {
    return (
      <p className="connect__text" data-testid="agent-connector-off">
        The Claude connector is not enabled on this server. Whoever runs it sets <code>ALDINE_MCP=1</code> (docs/AGENT_API.md); Claude then reaches it at <code>{connectorUrl}</code>.
      </p>
    );
  }

  const urlRow = (
    <div className="agent-connector">
      <code data-testid="agent-connector-url">{connectorUrl}</code>
      <button className="btn btn--small" onClick={() => copy(connectorUrl, 'Connector URL')} data-testid="agent-connector-copy">Copy connector URL</button>
    </div>
  );
  const unreachable = (
    <p className="connect__text connect__text--quiet" data-testid="agent-connector-unreachable">
      claude.ai, Claude Desktop and Cowork call this address from Anthropic's cloud and cannot reach it. Use Claude Code on this machine, or expose the instance over public HTTPS (docs/AGENT_API.md, “Reachability”).
    </p>
  );
  // The address appears once: on its own with a copy button where claude.ai
  // can use it, inside the runnable command where only Claude Code can.
  const code = (
    <>
      <p className="connect__text">
        {authEnabled
          ? 'Run this once in Claude Code, then type /mcp in a session and pick Aldine. It asks which projects Claude may touch.'
          : 'Run this once in a terminal, with this server\'s ALDINE_MCP_TOKEN in place of the placeholder (whoever runs the server has it).'}
      </p>
      <div className="agent-command">
        <code data-testid="agent-claude-code-command">claude mcp add --transport http aldine <span data-testid="agent-connector-url">{connectorUrl}</span>{header}</code>
        <button className="btn btn--small" onClick={() => copy(command, 'Command')} data-testid="agent-claude-code-copy">Copy command</button>
      </div>
      {cloudBlocked && unreachable}
    </>
  );
  const cloudShort = (
    <>
      <p className="connect__text">In Claude: Customize → Connectors → Add → Add custom connector. You pick which projects Claude may touch when it asks.</p>
      {urlRow}
    </>
  );
  const cloudSteps = (
    <ol className="connect__steps">
      <li>In Claude, open Customize → Connectors → Add → Add custom connector.</li>
      <li>Paste this address:{urlRow}</li>
      {authEnabled ? (
        <li>Click Connect, sign in, and pick the projects Claude may touch.</li>
      ) : (
        <li data-testid="connect-static-header">
          Under Request headers, add <code>X-Aldine-Token</code> with this server's <code>ALDINE_MCP_TOKEN</code> (whoever runs the server has it). Save without clicking Connect.
        </li>
      )}
    </ol>
  );

  // Account settings keeps to one route so the token list stays in view; a
  // switch between clients only makes sense when claude.ai can reach us.
  if (compact || cloudBlocked) return <div className="connect" data-testid="claude-connect">{cloudBlocked ? code : cloudShort}</div>;

  return (
    <div className="connect" data-testid="claude-connect">
      <div className="seg connect__clients" role="tablist" aria-label="Claude app">
        <button role="tab" aria-selected={client === 'cloud'} className={`seg__btn ${client === 'cloud' ? 'seg__btn--active' : ''}`} onClick={() => setClient('cloud')} data-testid="connect-client-cloud">claude.ai, Desktop, Cowork</button>
        <button role="tab" aria-selected={client === 'code'} className={`seg__btn ${client === 'code' ? 'seg__btn--active' : ''}`} onClick={() => setClient('code')} data-testid="connect-client-code">Claude Code</button>
      </div>
      {client === 'cloud' ? cloudSteps : code}
      <p className="connect__text connect__text--quiet">To check it, ask Claude to ping Aldine or to list your projects.</p>
    </div>
  );
}

/** The setup on its own, reachable from the palette and project settings. */
export default function ConnectClaudeModal({ onClose, onManage }: { onClose(): void; onManage?: () => void }) {
  const { authEnabled, mcpEnabled } = useAuth();
  return (
    <Modal onClose={onClose} label="Connect Claude" width={520} testId="connect-claude">
      <h2 style={{ marginBottom: 4 }}>Connect Claude</h2>
      <p className="modal__sub" style={{ marginBottom: 12 }}>Claude reads, edits and typesets your projects through the Aldine connector.</p>
      <ClaudeConnectSteps />
      <div className="modal__row" style={{ marginTop: 14 }}>
        {authEnabled && mcpEnabled && (
          onManage
            ? <button className="btn" onClick={() => { onClose(); onManage(); }} data-testid="connect-manage">Connections and tokens</button>
            : <span className="connect__text connect__text--quiet" style={{ marginRight: 'auto' }}>Connections and tokens are in Account settings, on the project list.</span>
        )}
        <button className="btn btn--primary" onClick={onClose} data-testid="connect-done">Done</button>
      </div>
    </Modal>
  );
}
