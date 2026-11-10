import {
  GoogleWorkspaceAuthorizeResponse,
  GoogleWorkspaceCompleteResponse,
  GoogleWorkspaceStatusResponse,
  GoogleWorkspaceTokenResponse,
} from 'generative-ai-use-cases';
import {
  completeGoogleAuthorization,
  getGoogleToken,
} from './utils/googleWorkspaceIdentity';
import {
  IntegrationUser,
  isUserInAllowList,
  resolveIntegrationReturnUrl,
  vaultUserId,
} from './utils/userIntegration';

// Business logic of the /google-workspace API
// (routes in api/routes/googleWorkspace.ts).

export const GOOGLE_WORKSPACE_CALLBACK_PATH = '/google-workspace/callback';

// The signed-in user, as the API Gateway Cognito authorizer verified it
export type GoogleWorkspaceUser = IntegrationUser;

export type GoogleWorkspaceResult<T> = {
  statusCode: number;
  body: T | { message: string };
};

export const isGoogleWorkspaceConfigured = (): boolean =>
  !!process.env.GOOGLE_WORKSPACE_WORKLOAD_NAME;

/**
 * Whether the user is in googleWorkspaceAllowedUsers (cognito:username,
 * case-insensitive). "*" allows every signed-in user. No one is allowed
 * while the list is empty.
 */
export const isAllowedUser = (user: GoogleWorkspaceUser): boolean =>
  isUserInAllowList('GOOGLE_WORKSPACE_ALLOWED_USERS', user);

/**
 * The page the browser returns to after Google consent, on the origin the
 * user started from (see resolveIntegrationReturnUrl).
 */
export const resolveReturnUrl = (origin: string | undefined): string =>
  resolveIntegrationReturnUrl(
    'GOOGLE_WORKSPACE_RETURN_ORIGINS',
    GOOGLE_WORKSPACE_CALLBACK_PATH,
    origin
  );

export { vaultUserId };

const forbidden = (): GoogleWorkspaceResult<never> => ({
  statusCode: 403,
  body: {
    message: 'You are not allowed to use the Google Workspace integration',
  },
});

export const getStatus = async (
  user: GoogleWorkspaceUser,
  origin: string | undefined
): Promise<GoogleWorkspaceResult<GoogleWorkspaceStatusResponse>> => {
  if (!isAllowedUser(user)) {
    return { statusCode: 200, body: { allowed: false, linked: false } };
  }
  const token = await getGoogleToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  return {
    statusCode: 200,
    body: { allowed: true, linked: 'accessToken' in token },
  };
};

export const authorize = async (
  user: GoogleWorkspaceUser,
  origin: string | undefined,
  force: boolean
): Promise<GoogleWorkspaceResult<GoogleWorkspaceAuthorizeResponse>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  const token = await getGoogleToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
    force,
  });
  return {
    statusCode: 200,
    body:
      'accessToken' in token
        ? { linked: true }
        : { linked: false, authorizationUrl: token.authorizationUrl },
  };
};

export const complete = async (
  user: GoogleWorkspaceUser,
  origin: string | undefined,
  sessionUri: unknown
): Promise<GoogleWorkspaceResult<GoogleWorkspaceCompleteResponse>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  if (
    typeof sessionUri !== 'string' ||
    sessionUri.length === 0 ||
    sessionUri.length > 2048
  ) {
    return { statusCode: 400, body: { message: 'sessionUri is required' } };
  }
  await completeGoogleAuthorization({
    userId: vaultUserId(user),
    sessionUri,
  });
  const token = await getGoogleToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  return { statusCode: 200, body: { linked: 'accessToken' in token } };
};

export const getAccessToken = async (
  user: GoogleWorkspaceUser,
  origin: string | undefined
): Promise<GoogleWorkspaceResult<GoogleWorkspaceTokenResponse>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  const token = await getGoogleToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  if (!('accessToken' in token)) {
    return {
      statusCode: 409,
      body: { message: 'Link your Google account first' },
    };
  }
  return { statusCode: 200, body: { accessToken: token.accessToken } };
};
