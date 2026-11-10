import {
  UserOAuth2TokenResult,
  completeUserOAuth2Authorization,
  getUserOAuth2Token,
} from './agentCoreTokenVault';
import { backlogGet, isRejectedToken } from './backlogApi';

// Backlog OAuth tokens of each user, kept in the AgentCore Identity Token
// Vault (see lib/construct/backlog.ts and agentCoreTokenVault.ts).

export type BacklogTokenResult = UserOAuth2TokenResult;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
};

// Backlog OAuth has no scopes: a token carries every permission of the user.
// GetResourceOauth2Token requires the scopes field anyway. An empty list is
// tried first; if AgentCore Identity rejects it, a placeholder (which Backlog
// ignores) is used from then on. The choice is deterministic, so tokens are
// always stored and looked up under the same scopes.
const SCOPE_CANDIDATES: string[][] = [[], ['read']];
let scopeIndex = 0;

const isValidationError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ValidationException';

/**
 * The user's Backlog access token, or the URL of a new Backlog consent when
 * no token is stored (or when force is set). The vault refreshes the 1-hour
 * access token with the refresh token Backlog issued.
 */
export const getBacklogToken = async (params: {
  userId: string;
  returnUrl: string;
  force?: boolean;
}): Promise<BacklogTokenResult> => {
  for (;;) {
    try {
      return await getUserOAuth2Token({
        workloadName: requiredEnv('BACKLOG_WORKLOAD_NAME'),
        credentialProviderName: requiredEnv('BACKLOG_CREDENTIAL_PROVIDER_NAME'),
        scopes: SCOPE_CANDIDATES[scopeIndex],
        userId: params.userId,
        returnUrl: params.returnUrl,
        force: params.force,
      });
    } catch (error) {
      if (
        isValidationError(error) &&
        scopeIndex === 0 &&
        SCOPE_CANDIDATES.length > 1
      ) {
        console.warn(
          'AgentCore Identity rejected empty scopes for Backlog; using a placeholder scope'
        );
        scopeIndex = 1;
        continue;
      }
      throw error;
    }
  }
};

/**
 * Bind a finished Backlog consent to the user (see
 * completeUserOAuth2Authorization).
 */
export const completeBacklogAuthorization = completeUserOAuth2Authorization;

export type BacklogTokenCheck =
  | { valid: true; userName: string }
  // Backlog rejected the token (revoked, or the vault could not refresh it)
  | { valid: false };

/**
 * Ask Backlog who the token belongs to. Throws when Backlog cannot be reached
 * or fails, which says nothing about the token.
 */
export const checkBacklogToken = async (
  accessToken: string
): Promise<BacklogTokenCheck> => {
  try {
    const me = await backlogGet<{ name?: unknown }>(
      accessToken,
      '/users/myself'
    );
    return {
      valid: true,
      userName: typeof me.name === 'string' ? me.name : '',
    };
  } catch (error) {
    if (isRejectedToken(error)) {
      return { valid: false };
    }
    throw error;
  }
};
