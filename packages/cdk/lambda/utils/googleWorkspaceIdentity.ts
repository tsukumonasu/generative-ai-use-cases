import {
  UserOAuth2TokenResult,
  completeUserOAuth2Authorization,
  getUserOAuth2Token,
} from './agentCoreTokenVault';

// Google OAuth tokens of each user, kept in the AgentCore
// Identity Token Vault (see lib/construct/google-workspace.ts and
// agentCoreTokenVault.ts).

export type GoogleTokenResult = UserOAuth2TokenResult;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

/**
 * The user's Google access token, or the URL of a new Google consent when no
 * token covering the scopes is stored (or when force is set).
 */
export const getGoogleToken = (params: {
  userId: string;
  returnUrl: string;
  force?: boolean;
}): Promise<GoogleTokenResult> =>
  getUserOAuth2Token({
    workloadName: requiredEnv('GOOGLE_WORKSPACE_WORKLOAD_NAME'),
    credentialProviderName: requiredEnv(
      'GOOGLE_WORKSPACE_CREDENTIAL_PROVIDER_NAME'
    ),
    scopes: requiredEnv('GOOGLE_WORKSPACE_SCOPES').split(' '),
    userId: params.userId,
    returnUrl: params.returnUrl,
    force: params.force,
    // Google issues a refresh token only with access_type=offline, and only
    // on a fresh consent for a user who has granted access before. Without
    // one the vault cannot renew the 1-hour access token.
    customParameters: { access_type: 'offline', prompt: 'consent' },
  });

/**
 * Bind a finished Google consent to the user (see
 * completeUserOAuth2Authorization).
 */
export const completeGoogleAuthorization = completeUserOAuth2Authorization;
