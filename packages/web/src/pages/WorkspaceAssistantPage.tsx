import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiSunHorizon,
  PiCalendarBlank,
  PiUsersThree,
  PiClock,
  PiEnvelopeSimple,
  PiChatsCircle,
  PiFiles,
  PiNotePencil,
  PiMicrosoftExcelLogo,
  PiMicrosoftPowerpointLogo,
  PiMicrosoftWordLogo,
  PiArrowBendUpLeft,
  PiFilePdf,
  PiGoogleDriveLogo,
} from 'react-icons/pi';
import AgentChatUnified, {
  AgentQuickAction,
} from '../components/agentBuilder/AgentChatUnified';
import useWorkspaceAssistant from '../hooks/useWorkspaceAssistant';
import useModelPreference from '../hooks/useModelPreference';
import { MODELS } from '../hooks/useModel';

// Buttons on the empty chat that send a ready-made request in one click. The
// label and prompt of each are workspace_assistant.quick_actions.<id> in the
// locale files. A request may create files and Gmail drafts, but must not
// change existing files or invite others: the assistant asks for the user's OK
// before those, which a one-click button would only interrupt.
const QUICK_ACTIONS: { id: string; icon: React.ReactNode }[] = [
  { id: 'briefing', icon: <PiSunHorizon /> },
  { id: 'today_schedule', icon: <PiCalendarBlank /> },
  { id: 'next_meeting', icon: <PiUsersThree /> },
  { id: 'free_time', icon: <PiClock /> },
  { id: 'unread_mail', icon: <PiEnvelopeSimple /> },
  { id: 'chat_updates', icon: <PiChatsCircle /> },
  { id: 'recent_files', icon: <PiFiles /> },
  { id: 'weekly_report', icon: <PiNotePencil /> },
  { id: 'schedule_excel', icon: <PiMicrosoftExcelLogo /> },
  { id: 'weekly_slides', icon: <PiMicrosoftPowerpointLogo /> },
  { id: 'agenda_doc', icon: <PiMicrosoftWordLogo /> },
  { id: 'reply_drafts', icon: <PiArrowBendUpLeft /> },
];

// Buttons under an answer that did not create a file: the assistant answers in
// the chat unless a file is asked for, and these turn the answer into one.
// Label and prompt: workspace_assistant.export_actions.<id>.
const EXPORT_ACTIONS: { id: string; icon: React.ReactNode }[] = [
  { id: 'word', icon: <PiMicrosoftWordLogo /> },
  { id: 'powerpoint', icon: <PiMicrosoftPowerpointLogo /> },
  { id: 'excel', icon: <PiMicrosoftExcelLogo /> },
  { id: 'pdf', icon: <PiFilePdf /> },
  { id: 'google_docs', icon: <PiGoogleDriveLogo /> },
];

// The Google Workspace assistant, a fixed Agent Builder agent
// (see hooks/useWorkspaceAssistant.ts)
const WorkspaceAssistantPage: React.FC = () => {
  const { t } = useTranslation();
  const baseAgent = useWorkspaceAssistant();
  // The model is picked in the input toolbar, like the chat page, and the
  // last one used is kept for the next visit
  const [modelId, setModelId] = useModelPreference(
    'workspaceAssistantModelId',
    MODELS.modelIds
  );
  const agent = useMemo(
    () => ({ ...baseAgent, modelId }),
    [baseAgent, modelId]
  );

  const quickActions: AgentQuickAction[] = useMemo(
    () =>
      QUICK_ACTIONS.map(({ id, icon }) => ({
        id,
        icon,
        label: t(`workspace_assistant.quick_actions.${id}.label`),
        prompt: t(`workspace_assistant.quick_actions.${id}.prompt`),
      })),
    [t]
  );

  const exportActions: AgentQuickAction[] = useMemo(
    () =>
      EXPORT_ACTIONS.map(({ id, icon }) => ({
        id,
        icon,
        label: t(`workspace_assistant.export_actions.${id}.label`),
        prompt: t(`workspace_assistant.export_actions.${id}.prompt`),
      })),
    [t]
  );

  return (
    <AgentChatUnified
      agent={agent}
      layout="fullscreen"
      showHeader={true}
      showAgentInfo={true}
      quickActions={quickActions}
      followUpActions={exportActions}
      modelSelectorInInput
      onModelChange={setModelId}
    />
  );
};

export default WorkspaceAssistantPage;
