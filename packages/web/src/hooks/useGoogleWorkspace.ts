import { useCallback } from 'react';
import {
  GoogleWorkspaceAuthorizeRequest,
  GoogleWorkspaceAuthorizeResponse,
  GoogleWorkspaceCompleteRequest,
  GoogleWorkspaceCompleteResponse,
  GoogleWorkspaceStatusResponse,
  GoogleWorkspaceTokenResponse,
} from 'generative-ai-use-cases';
import useHttp from './useHttp';

// Google Workspace MCP. Each user links their own Google account;
// the tokens stay in the AgentCore Identity Token Vault on the server side.
export const googleWorkspaceEnabled: boolean =
  import.meta.env.VITE_APP_GOOGLE_WORKSPACE_ENABLED === 'true';

export const GOOGLE_WORKSPACE_CALLBACK_PATHNAME = '/google-workspace/callback';

// Where users revoke the access they granted to GenU on the Google side
export const GOOGLE_ACCOUNT_CONNECTIONS_URL =
  'https://myaccount.google.com/connections';

// fetchStatus: set false where the link status is not needed (e.g. an agent
// that uses no Google server), so the status API is not called needlessly
const useGoogleWorkspace = (fetchStatus: boolean = true) => {
  const http = useHttp();
  // Do not call the API at all when the feature is not deployed
  const { data, error, isLoading, mutate } =
    http.get<GoogleWorkspaceStatusResponse>(
      googleWorkspaceEnabled && fetchStatus ? '/google-workspace/status' : null
    );

  // Start Google consent. Resolves to the consent URL to open, or null when the
  // account is already linked (and force is not set).
  const authorize = useCallback(
    async (force: boolean): Promise<string | null> => {
      const res = await http.post<
        GoogleWorkspaceAuthorizeResponse,
        GoogleWorkspaceAuthorizeRequest
      >('/google-workspace/authorize', { force });
      return res.data.linked ? null : res.data.authorizationUrl;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const complete = useCallback(
    async (sessionUri: string): Promise<boolean> => {
      const res = await http.post<
        GoogleWorkspaceCompleteResponse,
        GoogleWorkspaceCompleteRequest
      >('/google-workspace/complete', { sessionUri });
      await mutate();
      return res.data.linked;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate]
  );

  // The user's Google access token, or null when Google is not linked.
  // Fetched right before each agent invocation and kept in memory only.
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      const res = await http.post<GoogleWorkspaceTokenResponse>(
        '/google-workspace/token',
        {}
      );
      return res.data.accessToken;
    } catch (error) {
      console.warn('Google access token is not available');
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    enabled: googleWorkspaceEnabled,
    allowed: data?.allowed ?? false,
    linked: data?.linked ?? false,
    // e.g. the credential provider or IAM is misconfigured after a deploy
    statusError: !!error,
    isLoading,
    mutate,
    authorize,
    complete,
    getAccessToken,
  };
};

export default useGoogleWorkspace;
