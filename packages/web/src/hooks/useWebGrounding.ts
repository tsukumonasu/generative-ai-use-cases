import { WebSearchEngine } from 'generative-ai-use-cases';

// Web search chat (Amazon Nova web grounding / Bedrock Web Search).
// The page is an ordinary chat: the only difference is that its stream is
// served by a dedicated Lambda that offers the model a web_search tool
// (see packages/cdk/lambda/webGroundingStream.ts).

export const webGroundingEnabled: boolean =
  import.meta.env.VITE_APP_WEB_GROUNDING_ENABLED === 'true';

// Whether the user may switch the search engine behind that tool from Nova to
// Amazon Bedrock Web Search on GPT (webGroundingGptModelId in cdk.json)
export const webGroundingGptEnabled: boolean =
  webGroundingEnabled &&
  import.meta.env.VITE_APP_WEB_GROUNDING_GPT_ENABLED === 'true';

// useChat passes the pathname as the request id, which is how useChatApi knows
// to route the stream to the web grounding Lambda.
export const WEB_SEARCH_PATHNAME = '/web-search';

export const isWebSearchId = (id: string): boolean =>
  id === WEB_SEARCH_PATHNAME;

// The engine choice is a per-browser preference (localStorage), written by the
// selector on the page and read by useChatApi for every request.
export const WEB_SEARCH_ENGINE_STORAGE_KEY = 'webSearchEngine';

// GPT is preferred whenever it is configured: Nova is used only when the user
// explicitly picked it, or when GPT is not available at all.
export const DEFAULT_WEB_SEARCH_ENGINE: WebSearchEngine = webGroundingGptEnabled
  ? 'gpt'
  : 'nova';

export const toWebSearchEngine = (value: string | null): WebSearchEngine =>
  webGroundingGptEnabled && value !== 'nova' ? 'gpt' : 'nova';

export const getWebSearchEngine = (): WebSearchEngine => {
  try {
    return toWebSearchEngine(
      localStorage.getItem(WEB_SEARCH_ENGINE_STORAGE_KEY)
    );
  } catch {
    return DEFAULT_WEB_SEARCH_ENGINE;
  }
};
