// Gemini (Google Gemini API) image / video generation.
// Invokes the Lambda directly (see utils/invokeMediaLambda.ts).
import {
  GeminiMode,
  GeminiInvokeEvent,
  GenerateImageGeminiRequest,
  GenerateVideoGeminiRequest,
  GenerateGeminiResponse,
} from 'generative-ai-use-cases';
import { invokeMediaLambda } from '../utils/invokeMediaLambda';

const invoke = (
  mode: GeminiMode,
  request: GenerateImageGeminiRequest | GenerateVideoGeminiRequest,
  // Chat ID of an ongoing interactive session (appends to that chat)
  chatId?: string
): Promise<GenerateGeminiResponse> =>
  invokeMediaLambda<GeminiInvokeEvent, GenerateGeminiResponse>(
    import.meta.env.VITE_APP_GEMINI_FUNCTION_ARN ?? '',
    { mode, request, chatId }
  );

const useGeminiApi = () => {
  return {
    generateImage: (params: GenerateImageGeminiRequest, chatId?: string) => {
      return invoke('image', params, chatId);
    },
    generateVideo: (params: GenerateVideoGeminiRequest, chatId?: string) => {
      return invoke('video', params, chatId);
    },
  };
};

export default useGeminiApi;
