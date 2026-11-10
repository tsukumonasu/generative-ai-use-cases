import React from 'react';
import IntegrationCallback from '../components/IntegrationCallback';
import useBacklog, { BACKLOG_PATHNAME } from '../hooks/useBacklog';

// Backlog. AgentCore Identity sends the browser here after
// Backlog consent (see components/IntegrationCallback.tsx).
const BacklogCallbackPage: React.FC = () => {
  const backlog = useBacklog(false);
  return (
    <IntegrationCallback
      kind="backlog"
      integration={backlog}
      defaultNext={BACKLOG_PATHNAME}
    />
  );
};

export default BacklogCallbackPage;
