import React from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  // Read by screen readers and shown as the tooltip: the box has no label
  label: string;
  // Tooltip instead of the label, e.g. a short help text
  title?: string;
  disabled?: boolean;
  // Caps the width; the box otherwise fits the selected label
  maxWidthClassName?: string;
};

// A select in the same look as the model selector of the chat
// input toolbar (InputChatContent), so the pickers of other pages (the
// image / video settings, ...) match it. A native select
// is as wide as its longest option: the hidden span holds only the selected
// label, with the same padding, border and font, so the box fits the current
// choice, and the select is laid over it.
const SelectCompact: React.FC<Props> = ({
  value,
  onChange,
  options,
  label,
  title,
  disabled,
  maxWidthClassName = 'max-w-[160px] sm:max-w-[240px]',
}) => (
  <div className={`relative min-w-0 ${maxWidthClassName}`}>
    <span
      aria-hidden="true"
      className="invisible block h-[38px] truncate whitespace-nowrap border pl-3 pr-8 text-xs leading-[36px]">
      {options.find((o) => o.value === value)?.label ?? value}
    </span>
    <select
      aria-label={label}
      title={title ?? label}
      className="absolute inset-0 h-[38px] w-full truncate rounded-xl border border-gray-400 bg-white py-0 pl-3 pr-8 text-xs text-gray-700 disabled:opacity-50"
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

export default SelectCompact;
