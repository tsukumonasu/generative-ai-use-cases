import React from 'react';
import { useTranslation } from 'react-i18next';
import ChatPage from './ChatPage';
import SelectCompact from '../components/SelectCompact';
import { MODELS } from '../hooks/useModel';
import useLocalStorage from '../hooks/useLocalStorage';
import {
  DEFAULT_WEB_SEARCH_ENGINE,
  WEB_SEARCH_ENGINE_STORAGE_KEY,
  toWebSearchEngine,
  webGroundingGptEnabled,
} from '../hooks/useWebGrounding';

// Web search chat (Amazon Nova web grounding / Bedrock Web Search).
// This is the normal chat page: the route it is mounted on (/web-search) is
// what makes useChatApi stream it through the web grounding Lambda, which
// hands the selected model a web_search tool. When the GPT engine is
// configured, the user can pick which engine serves that tool, in the input
// toolbar next to the model selector.
const WebSearchChatPage: React.FC = () => {
  const { t } = useTranslation();
  const [engine, setEngine] = useLocalStorage(
    WEB_SEARCH_ENGINE_STORAGE_KEY,
    DEFAULT_WEB_SEARCH_ENGINE
  );

  return (
    <ChatPage
      pageTitle={t('websearch.title')}
      pageDescription={t('websearch.description')}
      // Web grounding goes through the Bedrock Converse API with tool use, so
      // SageMaker endpoints cannot be used here
      availableModelIds={MODELS.modelIds}
      inputToolbarContent={
        webGroundingGptEnabled ? (
          <SelectCompact
            label={t('websearch.engine_label')}
            title={t('websearch.engine_help')}
            value={toWebSearchEngine(engine)}
            onChange={setEngine}
            options={[
              { value: 'gpt', label: t('websearch.engine_gpt') },
              { value: 'nova', label: t('websearch.engine_nova') },
            ]}
          />
        ) : undefined
      }
    />
  );
};

export default WebSearchChatPage;
