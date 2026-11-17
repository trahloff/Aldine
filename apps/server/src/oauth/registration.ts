/**
 * Who may bring a new OAuth client (ALDINE_OAUTH_REGISTRATION). `open`, the
 * default: any client, through dynamic registration (POST /oauth/register) or
 * a Client ID Metadata Document URL. `closed`: only clients an administrator
 * registered on the server (`npm run oauth:add-client`); /oauth/register
 * answers 403, discovery stops advertising both paths, and no metadata
 * document is ever fetched. Any other value means `closed`, the stricter of
 * the two, and is warned about at boot.
 *
 * Read per call rather than at module load so one test process can exercise
 * both modes.
 */
export type RegistrationMode = 'open' | 'closed';

export function registrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  const v = (env.ALDINE_OAUTH_REGISTRATION || '').trim().toLowerCase();
  return v === '' || v === 'open' ? 'open' : 'closed';
}

export function registrationConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.ALDINE_OAUTH_REGISTRATION || '').trim();
  if (!raw || raw.toLowerCase() === 'open' || raw.toLowerCase() === 'closed') return [];
  return [`[aldine] ALDINE_OAUTH_REGISTRATION=${JSON.stringify(raw.slice(0, 40))} is neither "open" nor "closed"; using "closed"`];
}

export const REGISTRATION_CLOSED_MESSAGE = 'Client registration is closed on this server. Ask its administrator to register the client and give you its client ID';
