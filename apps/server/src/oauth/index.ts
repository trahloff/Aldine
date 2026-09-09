/**
 * OAuth 2.1 authorization server for the MCP connector. Aldine is both the
 * resource server (/mcp) and the authorization server; see
 * docs/plans/agent-api/06-oauth.md for the protocol surface.
 */
export { registerOAuth } from './routes.js';
export { OAuthError } from './errors.js';
export { protectedResourceMetadata, authorizationServerMetadata, resourceUri, resourceMetadataUrl, isOurResource, wwwAuthenticate, SCOPE } from './metadata.js';
export { issueCode, consumeCode, CODE_TTL_MS } from './codes.js';
export { fetchClientMetadata, parseClientIdUrl, parseClientMetadata, isAllowedRedirectUri, isBlockedAddress } from './cimd.js';
export { resolveClient, redirectUriMatches, DCR_PREFIX } from './clients.js';
export { registerClient, MAX_CLIENTS } from './register.js';
export { exchangeCode, refreshTokens, revokeToken, checkResource, ACCESS_TTL_MS, REFRESH_TTL_MS, REFRESH_PREFIX } from './token.js';
import { resetCodesForTests } from './codes.js';
import { resetCimdCacheForTests } from './cimd.js';

/** Test hook: clear the in-memory authorization codes and the metadata cache. */
export function resetOAuthStateForTests(): void {
  resetCodesForTests();
  resetCimdCacheForTests();
}
