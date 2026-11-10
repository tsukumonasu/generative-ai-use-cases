import React from 'react';
import IntegrationCallback from '../components/IntegrationCallback';
import useGoogleWorkspace from '../hooks/useGoogleWorkspace';
import {
  WORKSPACE_ASSISTANT_PATHNAME,
  workspaceAssistantEnabled,
} from '../hooks/useWorkspaceAssistant';

// Google Workspace MCP. AgentCore Identity sends the browser here
// after Google consent (see components/IntegrationCallback.tsx).
const GoogleWorkspaceCallbackPage: React.FC = () => {
  const googleWorkspace = useGoogleWorkspace(false);
  return (
    <IntegrationCallback
      kind="google_workspace"
      integration={googleWorkspace}
      defaultNext={
        workspaceAssistantEnabled ? WORKSPACE_ASSISTANT_PATHNAME : '/setting'
      }
    />
  );
};

export default GoogleWorkspaceCallbackPage;
