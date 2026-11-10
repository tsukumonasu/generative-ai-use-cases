import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from '../Markdown';
import Textarea from '../Textarea';
import { BacklogTextFormat } from '../../prompts/backlogDraft';
import SelectCompact from '../SelectCompact';
import { MODELS } from '../../hooks/useModel';
import { useTextModelOptions } from '../../hooks/useModelPreference';

// Pieces shared by the Backlog draft forms

// The draft button with the model picker on its left, the same order as the
// chat input (model, then send)
export const BacklogDraftActions: React.FC<{
  modelId: string;
  onModelChange: (modelId: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ modelId, onModelChange, disabled, children }) => {
  const { t } = useTranslation();
  const options = useTextModelOptions(MODELS.modelIds);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SelectCompact
        label={t('inputs.model')}
        value={modelId}
        onChange={onModelChange}
        options={options}
        disabled={disabled}
      />
      {children}
    </div>
  );
};

// A body editor with a preview in the project's text format
export const BacklogBodyEditor: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  format: BacklogTextFormat;
  disabled?: boolean;
}> = ({ label, value, onChange, format, disabled }) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="flex gap-3 text-xs">
          <span className="text-gray-500">
            {format === 'markdown'
              ? t('backlog.compose.format_markdown')
              : t('backlog.compose.format_backlog')}
          </span>
          <button
            type="button"
            className="text-aws-smile underline"
            onClick={() => setPreview(!preview)}>
            {preview ? t('backlog.compose.edit') : t('backlog.compose.preview')}
          </button>
        </span>
      </div>
      {preview ? (
        <div className="max-h-128 overflow-y-auto rounded border p-3 text-sm">
          {format === 'markdown' ? (
            <Markdown>{value}</Markdown>
          ) : (
            <pre className="whitespace-pre-wrap break-words">{value}</pre>
          )}
        </div>
      ) : (
        <Textarea
          value={value}
          onChange={onChange}
          rows={14}
          maxHeight={600}
          disabled={disabled}
        />
      )}
    </div>
  );
};

// A label with a "default" mark for values the user did not ask for
export const FieldLabel: React.FC<{ label: string; defaulted?: boolean }> = ({
  label,
  defaulted,
}) => {
  const { t } = useTranslation();
  return (
    <span className="text-sm">
      {label}
      {defaulted && (
        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
          {t('backlog.compose.defaulted')}
        </span>
      )}
    </span>
  );
};

export const DateInput: React.FC<{
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}> = ({ label, value, onChange, disabled }) => (
  <label className="flex flex-col gap-1">
    {label}
    <input
      type="date"
      className="rounded border border-black/30 px-2 py-1 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  </label>
);
