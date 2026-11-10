import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentConfiguration } from 'generative-ai-use-cases';
import useMCPServers from './useMCPServers';
import { googleWorkspaceEnabled } from './useGoogleWorkspace';
import { MODELS } from './useModel';
import { workspaceAssistantSystemPrompt } from '../prompts/workspaceAssistant';

// A fixed agent on the Agent Builder runtime that everyone gets in
// the drawer, preconfigured with the Google Workspace MCP servers. It is not
// stored anywhere: the configuration below is what the Agent Builder chat
// sends with each request, as it does for a saved agent.

export const WORKSPACE_ASSISTANT_PATHNAME = '/workspace-assistant';

// It runs on the Agent Builder runtime and is pointless without Google
export const workspaceAssistantEnabled: boolean =
  import.meta.env.VITE_APP_AGENT_CORE_AGENT_BUILDER_ENABLED === 'true' &&
  googleWorkspaceEnabled;

// Server names in agent-builder/mcp.json. Names missing from the deployed
// config are dropped, so a server can be removed there without touching this.
const WORKSPACE_ASSISTANT_MCP_SERVERS = [
  'time',
  'google-workspace-search',
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-docs',
  'google-sheets',
  'google-slides',
  'google-chat',
  'google-people',
  // Built into the runtime: PowerPoint/Excel/Word files and PDFs
  'office-documents',
];

const useWorkspaceAssistant = (): AgentConfiguration => {
  const { t } = useTranslation();
  const availableMcpServers = useMCPServers();

  return useMemo(() => {
    const available = new Set(availableMcpServers.map((s) => s.name));
    const now = new Date();
    return {
      agentId: 'workspace-assistant',
      name: t('workspace_assistant.title'),
      description: t('workspace_assistant.description'),
      systemPrompt: workspaceAssistantSystemPrompt(now),
      mcpServers: WORKSPACE_ASSISTANT_MCP_SERVERS.filter((name) =>
        available.has(name)
      ),
      // The first model in cdk.json is the default one
      modelId: MODELS.modelIds[0] ?? '',
      codeExecutionEnabled: false,
      isPublic: false,
      tags: [],
      starCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      createdBy: '',
      isMyAgent: false,
    };
  }, [t, availableMcpServers]);
};

export default useWorkspaceAssistant;
