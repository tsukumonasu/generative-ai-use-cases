import React from 'react';
import { useTranslation } from 'react-i18next';
import IntegrationNotice from '../IntegrationNotice';
import { AgentIntegrations } from '../../hooks/useAgentIntegrationTokens';

type Props = {
  integrations: AgentIntegrations;
};

// Google Workspace MCP servers need the user's own account, linked right here
const AgentIntegrationNotices: React.FC<Props> = ({ integrations }) => {
  const { t } = useTranslation();
  const { usesGoogleWorkspace, googleWorkspace } = integrations;

  return (
    <>
      {usesGoogleWorkspace && (
        <IntegrationNotice
          kind="google_workspace"
          integration={googleWorkspace}
          notLinkedText={t('google_workspace.agent_not_linked')}
          notAllowedText={t('google_workspace.agent_not_allowed')}
          className="w-full max-w-md"
        />
      )}
    </>
  );
};

export default AgentIntegrationNotices;
