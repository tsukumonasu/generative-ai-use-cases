import { useEffect } from 'react';
import { MediaSettingField } from '../components/MediaSettings';

// The options depend on the model (and on each other): when the current
// value is no longer offered, switch to the fallback
const useValidMediaSettings = (fields: MediaSettingField[]) => {
  useEffect(() => {
    for (const field of fields) {
      if (
        field.options.length > 0 &&
        !field.options.some((o) => o.value === field.value)
      ) {
        field.onChange(field.fallback ?? field.options[0].value);
      }
    }
  });
};

export default useValidMediaSettings;
