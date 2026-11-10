// Helpers shared by the per-user account integrations (e.g. Google Workspace),
// whose tokens live in the AgentCore Identity Token Vault.

// The signed-in user, as the API Gateway Cognito authorizer verified it
export type IntegrationUser = {
  sub: string;
  username?: string;
  email?: string;
};

const listEnv = (name: string, separator: string): string[] =>
  (process.env[name] ?? '')
    .split(separator)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

/**
 * Whether the user is in the comma-separated allow list in the environment
 * variable (cognito:username, case-insensitive; never the email, which is
 * not an immutable identity). "*" allows every
 * signed-in user. No one is allowed while the list is empty.
 */
export const isUserInAllowList = (
  envName: string,
  user: IntegrationUser
): boolean => {
  const allowedUsers = listEnv(envName, ',').map((value) =>
    value.toLowerCase()
  );
  if (allowedUsers.includes('*')) {
    return true;
  }
  return !!user.username && allowedUsers.includes(user.username.toLowerCase());
};

/**
 * The page the browser returns to after consent. It has to be on the origin
 * the user started from, since the Cognito session that completes the binding
 * lives in the browser per origin. An origin that is not configured falls
 * back to the first one (the return URL must be pre-registered anyway).
 */
export const resolveIntegrationReturnUrl = (
  originsEnvName: string,
  callbackPath: string,
  origin: string | undefined
): string => {
  const origins = listEnv(originsEnvName, ',');
  if (origins.length === 0) {
    throw new Error(`${originsEnvName} is not set`);
  }
  const matched = origin
    ? origins.find((o) => o.toLowerCase() === origin.toLowerCase())
    : undefined;
  return `${matched ?? origins[0]}${callbackPath}`;
};

// Vault key of the user. AgentCore Identity recommends partitioning user IDs
// by identity provider, so another provider added later cannot collide.
export const vaultUserId = (user: IntegrationUser): string =>
  `cognito+${user.sub}`;
