import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiChatsCircle, PiFileText, PiX } from 'react-icons/pi';
import { toast } from 'sonner';
import Button from '../Button';
import ButtonIcon from '../ButtonIcon';
import ModalDialogSelectChat from '../ModalDialogSelectChat';
import {
  BacklogSources,
  MAX_SOURCE_LENGTH,
  isClaudeCodeLog,
  parseClaudeCodeLog,
} from '../../utils/backlogSource';

// Source material for a Backlog draft — a past GenU chat and/or
// a file (text, transcript, or a Claude Code conversation log)

// Claude Code logs of a long session reach tens of MB
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ACCEPTED_FILES = '.txt,.md,.markdown,.jsonl,.json,.vtt,.srt,.csv,.log';

type Props = {
  value: BacklogSources;
  onChange: (value: BacklogSources) => void;
  // Shown under a Claude Code log: only messages after this are used
  logSince?: string;
  disabled?: boolean;
};

const BacklogSourceInput: React.FC<Props> = ({
  value,
  onChange,
  logSince,
  disabled,
}) => {
  const { t } = useTranslation();
  const [chatOpen, setChatOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error(t('backlog.compose.source.too_large'));
      return;
    }
    const raw = await file.text();
    onChange({
      ...value,
      file: { name: file.name, raw, isLog: isClaudeCodeLog(raw) },
    });
  };

  const log = value.file?.isLog && parseClaudeCodeLog(value.file.raw, logSince);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm">{t('backlog.compose.source.label')}</div>
      <div className="flex flex-wrap gap-2">
        <Button outlined onClick={() => setChatOpen(true)} disabled={disabled}>
          <PiChatsCircle className="mr-1" />
          {t('backlog.compose.source.choose_chat')}
        </Button>
        <Button
          outlined
          onClick={() => fileInput.current?.click()}
          disabled={disabled}>
          <PiFileText className="mr-1" />
          {t('backlog.compose.source.choose_file')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_FILES}
          className="hidden"
          onChange={(e) => {
            onPickFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <p className="text-xs text-gray-500">
        {t('backlog.compose.source.hint')}
      </p>
      {value.chat && (
        <div className="flex items-center gap-x-2 rounded border px-2 py-1 text-sm">
          <PiChatsCircle className="shrink-0 text-base" />
          <span className="grow truncate">
            {value.chat.title}
            <span className="ml-1 text-xs text-gray-400">
              {t('imageChatContext.messageCount', {
                n: value.chat.messageCount,
              })}
            </span>
          </span>
          <ButtonIcon
            onClick={() => onChange({ ...value, chat: undefined })}
            disabled={disabled}>
            <PiX />
          </ButtonIcon>
        </div>
      )}
      {value.file && (
        <div className="flex items-center gap-x-2 rounded border px-2 py-1 text-sm">
          <PiFileText className="shrink-0 text-base" />
          <span className="grow truncate">
            {value.file.name}
            <span className="ml-1 text-xs text-gray-400">
              {log
                ? t('backlog.compose.source.log_messages', {
                    n: log.messageCount,
                  })
                : t('backlog.compose.source.characters', {
                    n: value.file.raw.length.toLocaleString(),
                  })}
            </span>
          </span>
          <ButtonIcon
            onClick={() => onChange({ ...value, file: undefined })}
            disabled={disabled}>
            <PiX />
          </ButtonIcon>
        </div>
      )}
      {log && log.messageCount === 0 && (
        <p className="text-xs text-amber-600">
          {t('backlog.compose.source.log_empty')}
        </p>
      )}

      <ModalDialogSelectChat
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        onSelect={(chat) => onChange({ ...value, chat })}
        transcriptMaxLength={MAX_SOURCE_LENGTH}
      />
    </div>
  );
};

export default BacklogSourceInput;
