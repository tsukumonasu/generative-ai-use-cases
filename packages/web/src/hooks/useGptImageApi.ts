// GPT Image (OpenAI Images API) generation / editing.
// Invokes the Lambda directly (see utils/invokeMediaLambda.ts).
import {
  GptImageMode,
  GptImageInvokeEvent,
  GenerateImageGptRequest,
  EditImageGptRequest,
  GenerateImageGptResponse,
} from 'generative-ai-use-cases';
import { invokeMediaLambda } from '../utils/invokeMediaLambda';

const invoke = (
  mode: GptImageMode,
  request: GenerateImageGptRequest | EditImageGptRequest,
  // Chat ID of an ongoing interactive session (appends to that chat)
  chatId?: string,
  // Usecase path the generation is recorded under (defaults server-side)
  usecase?: GptImageInvokeEvent['usecase']
): Promise<GenerateImageGptResponse> =>
  invokeMediaLambda<GptImageInvokeEvent, GenerateImageGptResponse>(
    import.meta.env.VITE_APP_GPT_IMAGE_FUNCTION_ARN ?? '',
    { mode, request, chatId, usecase }
  );

const useGptImageApi = () => {
  return {
    generateImage: (
      params: GenerateImageGptRequest,
      chatId?: string,
      usecase?: GptImageInvokeEvent['usecase']
    ) => {
      return invoke('generate', params, chatId, usecase);
    },
    editImage: (
      params: EditImageGptRequest,
      chatId?: string,
      usecase?: GptImageInvokeEvent['usecase']
    ) => {
      return invoke('edit', params, chatId, usecase);
    },
  };
};

export default useGptImageApi;
