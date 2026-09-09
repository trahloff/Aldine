/**
 * RFC 6749 §5.2 error shape shared by every OAuth endpoint. The description
 * is user- or developer-facing prose and must never carry a secret or say
 * whether a code/token existed (the caller maps all lookup failures to the
 * same `invalid_grant`).
 */
export type OAuthErrorCode =
  | 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client'
  | 'unsupported_grant_type' | 'invalid_scope' | 'invalid_target' | 'access_denied'
  | 'invalid_redirect_uri' | 'invalid_client_metadata' | 'server_error';

export class OAuthError extends Error {
  constructor(public code: OAuthErrorCode, public description: string, public status = 400) {
    super(description);
  }
  toJSON(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
