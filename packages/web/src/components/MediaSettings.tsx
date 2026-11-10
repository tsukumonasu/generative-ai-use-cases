import React from 'react';
import Select from './Select';
import SelectCompact from './SelectCompact';

// The generation settings of the image / video pages. A page
// describes its settings once as a list of fields; the main ones are shown
// as compact selects right in the input box (so they are seen and changed
// without opening anything), and all of them in the settings dialog.

export type MediaSettingField = {
  key: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  // Shown in the input box as well as in the dialog
  primary?: boolean;
  // Explanation shown in the dialog
  help?: string;
  // Selected when the value is not among the options (default: the first)
  fallback?: string;
};

// The main settings as one wrapping row inside the input box
export const MediaSettingsBar: React.FC<{
  fields: MediaSettingField[];
  // Shown after the selects (e.g. why there is nothing to set)
  note?: string;
  disabled?: boolean;
}> = ({ fields, note, disabled }) => {
  const primary = fields.filter((f) => f.primary);
  if (primary.length === 0 && !note) return null;
  return (
    <div className="mx-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {primary.map((field) => (
        <label
          key={field.key}
          className="flex min-w-0 items-center gap-x-1 text-xs text-gray-500">
          <span className="shrink-0">{field.label}</span>
          <SelectCompact
            label={field.label}
            value={field.value}
            onChange={field.onChange}
            options={field.options}
            disabled={disabled}
          />
        </label>
      ))}
      {note && <span className="text-xs text-gray-500">{note}</span>}
    </div>
  );
};

// Every setting, for the settings dialog
export const MediaSettingsForm: React.FC<{ fields: MediaSettingField[] }> = ({
  fields,
}) => (
  <>
    {fields.map((field) => (
      <div key={field.key}>
        <Select
          label={field.label}
          value={field.value}
          onChange={field.onChange}
          options={field.options}
          fullWidth
        />
        {field.help && (
          <p className="-mt-2 mb-1 text-xs text-gray-400">{field.help}</p>
        )}
      </div>
    ))}
  </>
);
