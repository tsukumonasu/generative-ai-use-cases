import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShownMessage } from 'generative-ai-use-cases';
import GeneratedFilePreview from './GeneratedFilePreview';
import { findGeneratedFiles } from '../../utils/generatedFiles';
import {
  AgentChatExtensionProps,
  AgentQuickSend,
} from '../../hooks/useAgentChatExtensions';

type Props = Pick<AgentChatExtensionProps, 'followUpActions'> & {
  messages: ShownMessage[];
  idx: number;
  loading: boolean;
  quickSend: AgentQuickSend;
  onSend: () => void;
};

// Under a finished answer, previews of the files it created
// (office-documents) or, for the latest answer without files, the
// follow-up buttons. Indented like the answer text in ChatMessage.
const AgentAnswerExtras: React.FC<Props> = ({
  followUpActions,
  messages,
  idx,
  loading,
  quickSend,
  onSend,
}) => {
  const { t } = useTranslation();

  const message = messages[idx];
  const isLatest = idx === messages.length - 1;
  if (message.role !== 'assistant' || (loading && isLatest)) {
    return null;
  }
  const files = findGeneratedFiles(message.content);
  const showFollowUps =
    isLatest && files.length === 0 && !!followUpActions?.length;
  if (files.length === 0 && !showFollowUps) return null;

  return (
    <div className="flex justify-center bg-gray-100/70 print:hidden">
      <div className="w-full px-3 pb-3 md:w-11/12 lg:w-5/6 xl:w-4/6">
        <div className="ml-14 pr-8 lg:pr-14">
          {files.map((file) => (
            <GeneratedFilePreview key={file.keyBase} file={file} />
          ))}
          {showFollowUps && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">
                {t('agent_builder.follow_up_actions_hint')}
              </span>
              {followUpActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={loading}
                  onClick={() => quickSend.send(action.prompt, onSend)}
                  title={action.prompt || action.label}
                  className="hover:border-aws-smile flex items-center gap-1 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50">
                  {action.icon && (
                    <span className="text-aws-smile text-sm">
                      {action.icon}
                    </span>
                  )}
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentAnswerExtras;
