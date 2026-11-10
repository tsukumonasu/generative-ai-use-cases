import React, { useCallback, useMemo, useRef } from 'react';
import { MODELS } from './useModel';

// Optional extensions of AgentChatUnified for fixed assistants (e.g. the
// Google Workspace assistant). The logic lives here and in the Agent*.tsx
// files next to that component, so the component only carries call sites.

// A preset prompt shown as a button on the empty chat, sent as it is when
// clicked so the user does not have to type anything
export type AgentQuickAction = {
  id: string;
  label: string;
  prompt: string;
  // Shown on hover instead of the prompt, when the prompt alone does not say
  // what the button does
  description?: string;
  icon?: React.ReactNode;
};

// The optional props of AgentChatUnified for fixed assistants
export type AgentChatExtensionProps = {
  quickActions?: AgentQuickAction[];
  // Buttons under the latest answer (e.g. "export as Word"), shown when that
  // answer did not already produce a file
  followUpActions?: AgentQuickAction[];
  // The model selector sits in the input toolbar, like the chat page
  // (upstream #1788), instead of the header
  modelSelectorInInput?: boolean;
  // Called with the model the user picked (to remember it)
  onModelChange?: (modelId: string) => void;
};

// The model selector props of InputChatContent; empty when the selector stays
// in the header
export const useInputModelProps = (
  { modelSelectorInInput = false, onModelChange }: AgentChatExtensionProps,
  modelId: string,
  setModelId: (modelId: string) => void
) => {
  const { modelIds: availableModels, modelDisplayName } = MODELS;
  const modelOptions = useMemo(
    () =>
      availableModels.map((model) => ({
        value: model,
        label: modelDisplayName(model),
      })),
    [availableModels, modelDisplayName]
  );
  const onChangeModel = useCallback(
    (newModelId: string) => {
      setModelId(newModelId);
      onModelChange?.(newModelId);
    },
    [setModelId, onModelChange]
  );
  return modelSelectorInInput
    ? { modelId, onModelChange: onChangeModel, modelOptions }
    : {};
};

// A clicked quick action's prompt reaches handleSendMessage through a ref
// rather than a parameter, so that callback keeps its zero-arg shape.
export const useQuickSend = () => {
  const promptRef = useRef<string | null>(null);
  // Set while the tokens are fetched (before loading turns on), so a double
  // click on a quick action does not send twice
  const sendingRef = useRef(false);

  return useMemo(
    () => ({
      // Send this prompt instead of the input box text
      send: (prompt: string, handleSendMessage: () => void) => {
        promptRef.current = prompt;
        handleSendMessage();
      },
      // The clicked quick action's prompt, or null for a normal send
      takePrompt: (): string | null => {
        const prompt = promptRef.current;
        promptRef.current = null;
        return prompt;
      },
      // False when a send is already on its way
      begin: (): boolean => {
        if (sendingRef.current) return false;
        sendingRef.current = true;
        return true;
      },
      end: () => {
        sendingRef.current = false;
      },
    }),
    []
  );
};

export type AgentQuickSend = ReturnType<typeof useQuickSend>;

// With quick actions the fullscreen empty state takes its natural height plus
// room for the fixed input box, so the buttons do not end up behind the input
// box on short screens.
export const fullscreenEmptyStateHeight = (
  quickActions?: AgentQuickAction[]
): string => (quickActions?.length ? 'pb-48 pt-6' : 'h-[calc(100vh-13rem)]');
