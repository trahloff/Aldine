/**
 * Discovery documents (RFC 9728 protected-resource metadata, RFC 8414
 * authorization-server metadata) and the /mcp bearer challenge. Aldine is both
 * the resource server and its own authorization server, so every URL hangs
 * off one issuer = publicBase(req).
 */

export const SCOPE = 'projects';

/** Canonical resource identifier of the MCP server (RFC 8707): `<issuer>/mcp`. */
export function resourceUri(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/mcp`;
}

/**
 * Is `presented` the same resource as `<issuer>/mcp`? Scheme and host compare
 * case-insensitively, a trailing slash is tolerated, nothing else is
 * (no query, no fragment, no default-port aliasing games).
 */
export function isOurResource(issuer: string, presented: string): boolean {
  let a: URL, b: URL;
  try { a = new URL(resourceUri(issuer)); b = new URL(presented); } catch { return false; }
  if (b.search || b.hash || b.username || b.password) return false;
  return a.origin.toLowerCase() === b.origin.toLowerCase() && a.pathname === b.pathname.replace(/\/$/, '');
}

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: resourceUri(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Aldine',
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [SCOPE],
  };
}

/** Where a client finds the protected-resource document for `/mcp`. The
 *  path-suffixed form is the RFC 9728 location for a resource at `/mcp`;
 *  the root form is served too for clients that probe it. */
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/** `WWW-Authenticate` value for a /mcp 401 (RFC 6750 §3 + RFC 9728 §5.1). */
export function wwwAuthenticate(issuer: string, opts: { invalidToken: boolean }): string {
  const params = [
    ...(opts.invalidToken ? ['error="invalid_token"', 'error_description="The access token is missing, expired, or revoked"'] : []),
    `resource_metadata="${resourceMetadataUrl(issuer)}"`,
    `scope="${SCOPE}"`,
  ];
  return `Bearer ${params.join(', ')}`;
}
