// Google Workspace MCP.
// Each user links their own Google account (user-delegated OAuth). The tokens
// are kept in the AgentCore Identity Token Vault, keyed by the Cognito user,
// and are served only through the Cognito-authorized /google-workspace API.

export type GoogleWorkspaceStatusResponse = {
  // Whether the signed-in user may use the integration (googleWorkspaceAllowedUsers)
  allowed: boolean;
  // Whether a Google token covering the configured scopes is stored for the user
  linked: boolean;
};

export type GoogleWorkspaceAuthorizeRequest = {
  // Start a new consent even when a token is already stored (e.g. to switch
  // to another Google account or to grant newly added scopes)
  force?: boolean;
};

export type GoogleWorkspaceAuthorizeResponse =
  | { linked: true }
  | { linked: false; authorizationUrl: string };

export type GoogleWorkspaceCompleteRequest = {
  // The session_id query parameter AgentCore Identity appends to the return URL
  sessionUri: string;
};

export type GoogleWorkspaceCompleteResponse = {
  linked: boolean;
};

export type GoogleWorkspaceTokenResponse = {
  // Short-lived Google access token of the signed-in user. Keep it in memory
  // only: never log it, store it, or put it in chat history.
  accessToken: string;
};
