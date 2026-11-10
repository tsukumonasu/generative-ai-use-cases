import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AgentChatExtensionProps,
  AgentQuickSend,
} from '../../hooks/useAgentChatExtensions';

type Props = Pick<AgentChatExtensionProps, 'quickActions'> & {
  quickSend: AgentQuickSend;
  disabled: boolean;
  onSend: () => void;
};

// What the empty chat shows under the agent's name: preset prompts sent with
// one click
const AgentQuickActions: React.FC<Props> = ({
  quickActions,
  quickSend,
  disabled,
  onSend,
}) => {
  const { t } = useTranslation();

  return (
    <>
      {!!quickActions && quickActions.length > 0 && (
        <div className="mt-6 w-full max-w-4xl px-4 print:hidden">
          <p className="mb-3 text-center text-sm text-gray-500">
            {t('agent_builder.quick_actions_hint')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {quickActions.map((action) => (
              <div key={action.id} className="group relative">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => quickSend.send(action.prompt, onSend)}
                  aria-describedby={`quick-action-${action.id}`}
                  className="hover:border-aws-smile flex h-full w-full items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left text-sm shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
                  {action.icon && (
                    <span className="text-aws-smile shrink-0 text-xl">
                      {action.icon}
                    </span>
                  )}
                  <span className="font-medium text-gray-700">
                    {action.label}
                  </span>
                </button>
                {/* What the button does, shown below it on hover / focus. It
                    never takes the pointer, so it cannot cover a button. */}
                {(action.description || action.prompt) && (
                  <div
                    id={`quick-action-${action.id}`}
                    role="tooltip"
                    className="pointer-events-none invisible absolute left-1/2 top-full z-50 mt-2 w-72 -translate-x-1/2 rounded border border-gray-400 bg-black/75 p-2 text-xs leading-relaxed text-white opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 group-hover:delay-200">
                    {action.description || action.prompt}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

export default AgentQuickActions;
