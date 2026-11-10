import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PiPaperclip, PiSpinnerGap, PiX } from 'react-icons/pi';
import ButtonIcon from './ButtonIcon';
import ScrollTopBottom from './ScrollTopBottom';
import Tooltip from './Tooltip';
import useDropOverlay from '../hooks/useDropOverlay';

// The layout of the image / video pages, the same as the chat
// page: the session's prompt -> result exchanges stacked in the middle, and
// the input box (InputChatContent, with the model selector) fixed at the
// bottom.

type LayoutProps = {
  title: string;
  // One-line explanation shown above an empty session, like the chat page
  description?: string;
  emptyIcon: React.ReactNode;
  emptyText: string;
  isEmpty: boolean;
  // Links shown above the exchanges (PDF, open in history)
  actions?: React.ReactNode;
  // Files dropped anywhere on the page
  onDropFiles?: (files: File[]) => void;
  // The input box (InputChatContent)
  input: React.ReactNode;
  // The exchanges
  children: React.ReactNode;
};

export const MediaSessionLayout: React.FC<LayoutProps> = ({
  title,
  description,
  emptyIcon,
  emptyText,
  isEmpty,
  actions,
  onDropFiles,
  input,
  children,
}) => {
  const { t } = useTranslation();
  const onDrop = useCallback(
    (files: File[]) => onDropFiles?.(files),
    [onDropFiles]
  );
  const { isOver, hideOverlay, handleDragOver, handleDragLeave, handleDrop } =
    useDropOverlay(onDrop);

  return (
    <div
      onDragOver={onDropFiles ? handleDragOver : undefined}
      className={`${!isEmpty ? 'screen:pb-60' : ''} relative`}>
      <div className="invisible my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {title}
      </div>

      {isOver && onDropFiles && (
        <div
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={hideOverlay}
          className="fixed bottom-0 left-0 right-0 top-0 z-[999] bg-slate-300 p-10 text-center">
          <ButtonIcon
            className="absolute right-3 top-3"
            title={t('common.close')}
            onClick={hideOverlay}>
            <PiX />
          </ButtonIcon>
          <div className="flex h-full w-full items-center justify-center outline-dashed">
            <div className="font-bold">{t('chat.drop_files')}</div>
          </div>
        </div>
      )}

      {description && isEmpty && (
        <div className="mt-2 flex w-full justify-center px-4 text-center text-xs text-gray-600 print:hidden">
          {description}
        </div>
      )}

      {isEmpty ? (
        <div className="flex h-[calc(100vh-13rem)] flex-col items-center justify-center gap-y-2 text-gray-400">
          {emptyIcon}
          <div className="px-4 text-center text-sm">{emptyText}</div>
        </div>
      ) : (
        <>
          {actions && (
            <div className="my-2 flex items-center justify-end gap-x-4 pr-3 print:hidden">
              {actions}
            </div>
          )}
          <div className="flex justify-center">
            <div className="flex w-11/12 flex-col gap-y-6 pb-4 md:w-10/12 lg:w-4/6 xl:w-3/6">
              {children}
            </div>
          </div>
        </>
      )}

      <div className="fixed right-4 top-[calc(50vh-2rem)] z-0 lg:right-8">
        <ScrollTopBottom />
      </div>

      <div className="fixed bottom-0 z-0 flex w-full flex-col items-center justify-center lg:pr-64 print:hidden">
        {input}
      </div>
    </div>
  );
};

// One prompt -> result exchange: the prompt on the right like a chat message,
// the model that answered under it, then the results
export const MediaExchange: React.FC<{
  prompt: string;
  modelLabel?: string;
  children: React.ReactNode;
}> = ({ prompt, modelLabel, children }) => (
  <div className="flex flex-col gap-y-2">
    <div className="flex flex-col items-end gap-y-1">
      <div className="bg-aws-smile/10 max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm">
        {prompt}
      </div>
      {modelLabel && <div className="text-xs text-gray-400">{modelLabel}</div>}
    </div>
    {children}
  </div>
);

// The progress row at the end of the exchanges
export const MediaGenerating: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex flex-col items-center gap-y-2 py-8 text-gray-400">
    <PiSpinnerGap className="h-12 w-12 animate-spin" />
    <div className="text-center text-sm">{text}</div>
  </div>
);

// A toolbar button of the input box, in the look of its attachment button
export const InputToolbarButton: React.FC<{
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  // Turns the button into a file picker
  accept?: string[];
  multiple?: boolean;
  onFiles?: (files: File[]) => void;
}> = ({
  label,
  icon,
  active,
  loading,
  disabled,
  onClick,
  accept,
  multiple,
  onFiles,
}) => {
  const className = `${
    loading || disabled ? 'bg-gray-300' : 'cursor-pointer bg-white'
  } ${
    active ? 'text-aws-smile border-aws-smile' : 'border-gray-400 text-gray-400'
  } flex items-center justify-center rounded-xl border p-2 align-bottom text-xl`;
  const content = loading ? <PiSpinnerGap className="animate-spin" /> : icon;
  return (
    <Tooltip message={label} position="center" topPosition="-top-16" nowrap>
      {onFiles ? (
        <label aria-label={label}>
          <input
            hidden
            type="file"
            accept={accept?.join(',')}
            multiple={multiple}
            disabled={loading || disabled}
            value={[]}
            onChange={(e) => {
              if (e.target.files) onFiles(Array.from(e.target.files));
            }}
          />
          <div className={className}>{content}</div>
        </label>
      ) : (
        <button
          type="button"
          aria-label={label}
          className={className}
          disabled={loading || disabled}
          onClick={onClick}>
          {content}
        </button>
      )}
    </Tooltip>
  );
};

// The attachment button of the image / video pages
export const MediaAttachButton: React.FC<{
  accept: string[];
  hasFiles: boolean;
  loading?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}> = ({ accept, hasFiles, loading, disabled, onFiles }) => {
  const { t } = useTranslation();
  return (
    <InputToolbarButton
      label={t('inputs.attachment')}
      icon={<PiPaperclip />}
      active={hasFiles}
      loading={loading}
      disabled={disabled}
      accept={accept}
      multiple
      onFiles={onFiles}
    />
  );
};

// A chip inside the input box (the referenced chat, continuing an edit, ...)
export const InputChip: React.FC<{
  icon: React.ReactNode;
  children: React.ReactNode;
  removeLabel: string;
  onRemove: () => void;
}> = ({ icon, children, removeLabel, onRemove }) => (
  <div className="flex max-w-full items-center gap-x-1 rounded-lg border border-gray-300 bg-white py-0.5 pl-2 pr-1 text-xs text-gray-700">
    <span className="text-aws-smile shrink-0 text-sm">{icon}</span>
    <span className="min-w-0 truncate">{children}</span>
    <ButtonIcon onClick={onRemove} title={removeLabel}>
      <PiX className="text-sm" />
    </ButtonIcon>
  </div>
);
