import { useMemo } from 'react';
import { MODELS, findModelByModelId } from './useModel';
import useModelPreference from './useModelPreference';

// The model that writes the Backlog page's drafts, one choice for
// every form of the page (remembered per browser like the chat page's model)
const useBacklogDraftModel = () => {
  const [modelId, setModelId] = useModelPreference(
    'backlogDraftModelId',
    MODELS.modelIds
  );
  const model = useMemo(() => findModelByModelId(modelId), [modelId]);
  return { modelId, setModelId, model };
};

export default useBacklogDraftModel;
