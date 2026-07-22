// Fork custom: modal to pick an existing chat as context for image generation.
// Fetches the selected chat's messages and returns them as a transcript.
import React, { useCallback, useMemo, useState } from 'react';
import { Chat, ListMessagesResponse } from 'generative-ai-use-cases';
import ModalDialog from './ModalDialog';
import Button from './Button';
import useChatList from '../hooks/useChatList';
import useHttp from '../hooks/useHttp';
import { decomposeId } from '../utils/ChatUtils';
import { ImageChatContext, buildChatTranscript } from '../utils/chatContext';
import { PiChatsCircle, PiSpinnerGap } from 'react-icons/pi';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

// Chats recorded by the media generation pages themselves are not useful
// as conversation context — hide them from the picker
const EXCLUDED_USECASES = [
  '/gpt-image',
  '/gemini-image',
  '/gemini-video',
  '/image',
  '/video',
];

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (context: ImageChatContext) => void;
};

const ModalDialogSelectChat: React.FC<Props> = (props) => {
  const { t } = useTranslation();
  const { loading, chats, canLoadMore, loadMore } = useChatList();
  const { api } = useHttp();
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);

  const selectableChats = useMemo(() => {
    return chats.filter(
      (chat: Chat) => !EXCLUDED_USECASES.includes(chat.usecase)
    );
  }, [chats]);

  const onClickChat = useCallback(
    async (chat: Chat) => {
      const chatId = decomposeId(chat.chatId);
      if (!chatId || loadingChatId) {
        return;
      }
      setLoadingChatId(chat.chatId);
      try {
        const res = await api.get<ListMessagesResponse>(
          `chats/${chatId}/messages`
        );
        const messages = res.data.messages.filter(
          (m) => m.role !== 'system' && m.content
        );
        if (messages.length === 0) {
          toast.error(t('imageChatContext.error.emptyChat'));
          return;
        }
        props.onSelect({
          chatId,
          title: chat.title,
          messageCount: messages.length,
          transcript: buildChatTranscript(messages),
        });
        props.onClose();
      } catch (e) {
        console.error(e);
        toast.error(t('imageChatContext.error.loadFailed'));
      } finally {
        setLoadingChatId(null);
      }
    },
    [api, loadingChatId, props, t]
  );

  return (
    <ModalDialog
      isOpen={props.isOpen}
      title={t('imageChatContext.selectChat')}
      onClose={props.onClose}>
      <div className="flex max-h-96 flex-col gap-y-1 overflow-y-auto">
        {loading && selectableChats.length === 0 && (
          <div className="flex items-center justify-center py-8 text-gray-400">
            <PiSpinnerGap className="animate-spin text-2xl" />
          </div>
        )}
        {!loading && selectableChats.length === 0 && (
          <div className="py-8 text-center text-gray-400">
            {t('imageChatContext.noChats')}
          </div>
        )}
        {selectableChats.map((chat: Chat) => (
          <button
            key={chat.chatId}
            disabled={!!loadingChatId}
            onClick={() => {
              onClickChat(chat);
            }}
            className="flex items-center gap-x-2 rounded p-2 text-left hover:bg-gray-100 disabled:opacity-50">
            {loadingChatId === chat.chatId ? (
              <PiSpinnerGap className="shrink-0 animate-spin text-base" />
            ) : (
              <PiChatsCircle className="shrink-0 text-base" />
            )}
            <span className="truncate">{chat.title}</span>
          </button>
        ))}
        {canLoadMore && (
          <Button outlined onClick={loadMore} disabled={!!loadingChatId}>
            {t('imageChatContext.loadMore')}
          </Button>
        )}
      </div>
    </ModalDialog>
  );
};

export default ModalDialogSelectChat;
