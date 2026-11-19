import { useState } from 'react';
import { withBase } from '../basePath';
import { useAuth } from './Auth';
import { useToast } from './Toast';
import Modal from './Modal';

/** claude.ai and ChatGPT call the instance from their providers' clouds:
 *  plain http, loopback, RFC 1918 ranges and .local names never resolve from
 *  there. Claude Code (on the user's machine) reaches them fine. */
export function unreachableFromCloud(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return true;
    const h = u.hostname;
    return h === 'localhost' || /\.local$/i.test(h) || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h === '[::1]';
  } catch { return true; }
}

type Client = 'cloud' | 'code' | 'chatgpt';

/** The address the assistant is given: ALDINE_PUBLIC_URL when the server has one
 *  (what its OAuth metadata names too), else the address this page came from. */
export function useConnectorUrl(): string {
  const { publicUrl } = useAuth();
  return publicUrl ? `${publicUrl.replace(/\/+$/, '')}/mcp` : `${location.origin}${withBase('/mcp')}`;
}

/** How to add this instance to claude.ai (and Desktop and Cowork, which use
 *  the same connectors), Claude Code or ChatGPT. With auth on, Connect signs
 *  in and asks for the project scope; with auth off the instance has one
 *  static token, which only the operator knows, so it is named, never shown.
 *  ChatGPT authenticates only with OAuth and cannot send that token as a
 *  header, so it needs auth on. */
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
        The MCP connector is not enabled on this server. Whoever runs it sets <code>ALDINE_MCP=1</code> (docs/AGENT_API.md); Claude and ChatGPT then reach it at <code>{connectorUrl}</code>.
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
      claude.ai, Claude Desktop, Cowork and ChatGPT call this address from their providers' clouds and cannot reach it. Use Claude Code on this machine, or expose the instance over public HTTPS (docs/AGENT_API.md, “Reachability”).
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

  const chatgpt = authEnabled ? (
    <>
      <ol className="connect__steps" data-testid="connect-chatgpt-steps">
        <li>In ChatGPT on the web, open Plugins, select +, then Add custom MCP server.</li>
        <li>Name it Aldine and paste this address as the Server URL:{urlRow}</li>
        <li>Choose OAuth for Authentication, accept the risk warning, and select Create as a plugin.</li>
        <li>Install it, sign in to Aldine when asked, and pick the projects ChatGPT may touch.</li>
      </ol>
      <p className="connect__text connect__text--quiet">Whether you can add custom MCP servers depends on your ChatGPT plan and workspace settings.</p>
    </>
  ) : (
    <p className="connect__text" data-testid="connect-chatgpt-needs-signin">
      ChatGPT connects only through sign-in (OAuth) and cannot send this server's <code>X-Aldine-Token</code>. To connect ChatGPT, whoever runs the server turns on accounts with <code>AUTH_ENABLED=1</code> (docs/AGENT_API.md). Claude works with the token as it is.
    </p>
  );

  // Account settings keeps to one route so the token list stays in view; a
  // switch between clients only makes sense when claude.ai can reach us.
  if (compact || cloudBlocked) return <div className="connect" data-testid="claude-connect">{cloudBlocked ? code : cloudShort}</div>;

  return (
    <div className="connect" data-testid="claude-connect">
      <div className="seg connect__clients" role="tablist" aria-label="Assistant">
        <button role="tab" aria-selected={client === 'cloud'} className={`seg__btn ${client === 'cloud' ? 'seg__btn--active' : ''}`} onClick={() => setClient('cloud')} data-testid="connect-client-cloud">claude.ai, Desktop, Cowork</button>
        <button role="tab" aria-selected={client === 'code'} className={`seg__btn ${client === 'code' ? 'seg__btn--active' : ''}`} onClick={() => setClient('code')} data-testid="connect-client-code">Claude Code</button>
        <button role="tab" aria-selected={client === 'chatgpt'} className={`seg__btn ${client === 'chatgpt' ? 'seg__btn--active' : ''}`} onClick={() => setClient('chatgpt')} data-testid="connect-client-chatgpt">ChatGPT</button>
      </div>
      {client === 'cloud' ? cloudSteps : client === 'code' ? code : chatgpt}
      <p className="connect__text connect__text--quiet">To check it, ask {client === 'chatgpt' ? 'ChatGPT' : 'Claude'} to ping Aldine or to list your projects.</p>
    </div>
  );
}

/** The setup on its own, reachable from the palette and project settings. */
export default function ConnectClaudeModal({ onClose, onManage }: { onClose(): void; onManage?: () => void }) {
  const { authEnabled, mcpEnabled } = useAuth();
  return (
    <Modal onClose={onClose} label="Connect Claude or ChatGPT" width={520} testId="connect-claude">
      <h2 style={{ marginBottom: 4 }}>Connect Claude or ChatGPT</h2>
      <p className="modal__sub" style={{ marginBottom: 12 }}>Your assistant reads, edits and typesets your projects through the Aldine MCP connector.</p>
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
