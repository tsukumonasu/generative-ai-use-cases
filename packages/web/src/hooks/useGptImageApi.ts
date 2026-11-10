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
  chatId?: string
): Promise<GenerateImageGptResponse> =>
  invokeMediaLambda<GptImageInvokeEvent, GenerateImageGptResponse>(
    import.meta.env.VITE_APP_GPT_IMAGE_FUNCTION_ARN ?? '',
    { mode, request, chatId }
  );

const useGptImageApi = () => {
  return {
    generateImage: (params: GenerateImageGptRequest, chatId?: string) => {
      return invoke('generate', params, chatId);
    },
    editImage: (params: EditImageGptRequest, chatId?: string) => {
      return invoke('edit', params, chatId);
    },
  };
};

export default useGptImageApi;
