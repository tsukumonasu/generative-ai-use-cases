import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';

// Per-user OAuth tokens of external services (e.g. Google Workspace), kept in
// the AgentCore Identity Token Vault.
//
// The vault is keyed by (workload identity, user ID). AgentCore Identity does
// not verify the user ID, so callers must pass one derived from the API
// Gateway Cognito authorizer claims and never one taken from the request.

const client = new BedrockAgentCoreClient({});

export type UserOAuth2TokenResult =
  | { accessToken: string }
  | { authorizationUrl: string };

const getWorkloadAccessToken = async (
  workloadName: string,
  userId: string
): Promise<string> => {
  const res = await client.send(
    new GetWorkloadAccessTokenForUserIdCommand({ workloadName, userId })
  );
  if (!res.workloadAccessToken) {
    throw new Error('AgentCore Identity returned no workload access token');
  }
  return res.workloadAccessToken;
};

/**
 * The user's access token for the provider, or the URL of a new consent when
 * no token covering the scopes is stored (or when force is set).
 *
 * returnUrl is where AgentCore Identity sends the browser after consent, with
 * `?session_id=<session URI>` appended. It must be one of the workload
 * identity's allowedResourceOauth2ReturnUrls.
 */
export const getUserOAuth2Token = async (params: {
  workloadName: string;
  credentialProviderName: string;
  scopes: string[];
  userId: string;
  returnUrl: string;
  force?: boolean;
  customParameters?: Record<string, string>;
}): Promise<UserOAuth2TokenResult> => {
  const workloadIdentityToken = await getWorkloadAccessToken(
    params.workloadName,
    params.userId
  );
  const res = await client.send(
    new GetResourceOauth2TokenCommand({
      workloadIdentityToken,
      resourceCredentialProviderName: params.credentialProviderName,
      scopes: params.scopes,
      oauth2Flow: 'USER_FEDERATION',
      resourceOauth2ReturnUrl: params.returnUrl,
      forceAuthentication: params.force ?? false,
      customParameters: params.customParameters,
    })
  );
  if (res.accessToken) {
    return { accessToken: res.accessToken };
  }
  if (res.authorizationUrl) {
    return { authorizationUrl: res.authorizationUrl };
  }
  throw new Error(
    `AgentCore Identity returned neither a token nor an authorization URL (sessionStatus: ${res.sessionStatus})`
  );
};

/**
 * Bind a finished consent to the user. AgentCore Identity checks that this
 * user is the one who started it before storing the token, so a consent URL
 * that leaks to someone else can never link their account to this user.
 */
export const completeUserOAuth2Authorization = async (params: {
  userId: string;
  sessionUri: string;
}): Promise<void> => {
  await client.send(
    new CompleteResourceTokenAuthCommand({
      sessionUri: params.sessionUri,
      userIdentifier: { userId: params.userId },
    })
  );
};
