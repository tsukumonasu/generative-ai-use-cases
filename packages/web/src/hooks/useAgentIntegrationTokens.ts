import { useCallback, useMemo } from 'react';
import useMCPServers from './useMCPServers';
import useGoogleWorkspace from './useGoogleWorkspace';

// The per-user account links an agent needs. Google Workspace MCP servers run
// with the user's own Google token. The tokens are fetched right before each
// invocation and handed straight to it - never kept in state, stored or
// logged.
const useAgentIntegrationTokens = (mcpServers?: string[]) => {
  const availableMcpServers = useMCPServers();
  const usesGoogleWorkspace = useMemo(
    () =>
      (mcpServers ?? []).some(
        (name) =>
          availableMcpServers.find((server) => server.name === name)
            ?.requiresGoogleAuth
      ),
    [mcpServers, availableMcpServers]
  );
  const googleWorkspace = useGoogleWorkspace(usesGoogleWorkspace);
  const { getAccessToken: getGoogleAccessToken } = googleWorkspace;

  // [Google token], in the order of the last parameters of
  // invokeAgentRuntime. Without a token the runtime leaves the Google servers
  // out and the agent tells the user to link the account.
  const getAccessTokens = useCallback(async (): Promise<
    [string | undefined]
  > => {
    const googleAccessToken = usesGoogleWorkspace
      ? await getGoogleAccessToken()
      : null;
    return [googleAccessToken ?? undefined];
  }, [usesGoogleWorkspace, getGoogleAccessToken]);

  return {
    usesGoogleWorkspace,
    googleWorkspace,
    getAccessTokens,
  };
};

export type AgentIntegrations = ReturnType<typeof useAgentIntegrationTokens>;

export default useAgentIntegrationTokens;
