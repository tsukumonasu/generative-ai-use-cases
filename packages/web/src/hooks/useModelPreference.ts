import { useMemo } from 'react';
import useLocalStorage from './useLocalStorage';
import { MODELS } from './useModel';

// The model a page last used (image / manga planners, image / video models),
// remembered per browser like the chat page remembers its model. A saved
// model that is no longer offered falls back to the first candidate, the
// deployment's default.
const useModelPreference = (storageKey: string, candidates: string[]) => {
  const [saved, setSaved] = useLocalStorage(storageKey, '');
  const modelId = candidates.includes(saved) ? saved : (candidates[0] ?? '');
  return [modelId, setSaved] as const;
};

// Options for a model selector over Bedrock text models
export const useTextModelOptions = (modelIds: string[]) =>
  useMemo(
    () =>
      modelIds.map((modelId) => ({
        value: modelId,
        label: MODELS.modelDisplayName(modelId),
      })),
    [modelIds]
  );

export default useModelPreference;
