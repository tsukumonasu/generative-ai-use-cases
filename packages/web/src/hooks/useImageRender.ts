// One image-model call for the pages that offer both providers
// in one model selector (image page, manga page). Builds the request of the
// selected provider (GPT Image / Gemini), calls its Lambda and normalises the
// result to the permanent S3 URLs of the generated images.
import { useCallback } from 'react';
import {
  GeminiImageSize,
  GeminiImageThinkingLevel,
  GeminiInputMedia,
  GptImageBackground,
  GptImageInputImage,
  GptImageInvokeEvent,
  GptImageOutputFormat,
  GptImageQuality,
  GptImageSize,
} from 'generative-ai-use-cases';
import useGptImageApi from './useGptImageApi';
import useGeminiApi from './useGeminiApi';
import { ImageProvider } from '../utils/mediaModels';

// An input / reference image: inline base64 `data`, or an `s3Url` that the
// Lambda resolves to bytes (keeps the invoke payload small)
export type ImageRenderInput = GptImageInputImage & GeminiInputMedia;

export type ImageRenderRequest = {
  provider: ImageProvider;
  // '' = not sent: the Lambda uses its default model
  modelId: string;
  prompt: string;
  // Recorded in the chat history instead of the prompt
  historyPrompt?: string;
  // Transcript of a referenced chat, prepended for the model call only
  chatContext?: string;
  n: number;
  // With images GPT Image uses its edit endpoint; Gemini takes them as inputs
  images?: ImageRenderInput[];
  // Settings of both providers; only the selected provider's are sent
  // (the optional ones are left to the API default when not set)
  gpt: {
    size: GptImageSize;
    quality: GptImageQuality;
    background?: GptImageBackground;
    outputFormat?: GptImageOutputFormat;
    outputCompression?: number;
    frameCount?: number;
    frameDurationMs?: number;
  };
  gemini: {
    aspectRatio: string;
    imageSize: GeminiImageSize;
    thinkingLevel?: GeminiImageThinkingLevel;
  };
  // Chat of the ongoing session (the generation is appended to it)
  sessionChatId?: string;
  // Usecase the generation is recorded under (defaults server-side to the
  // provider's own); only usecases both providers accept
  usecase?: Extract<GptImageInvokeEvent['usecase'], '/manga'>;
};

export type ImageRenderResult = {
  s3Urls: string[];
  chatId?: string;
};

const useImageRender = () => {
  const { generateImage: generateGptImage, editImage: editGptImage } =
    useGptImageApi();
  const { generateImage: generateGeminiImage } = useGeminiApi();

  const renderImage = useCallback(
    async (req: ImageRenderRequest): Promise<ImageRenderResult> => {
      const modelField = req.modelId ? { model: req.modelId } : {};
      const hasImages = !!req.images && req.images.length > 0;

      if (req.provider === 'gpt') {
        const common = {
          prompt: req.prompt,
          historyPrompt: req.historyPrompt,
          chatContext: req.chatContext,
          size: req.gpt.size,
          quality: req.gpt.quality,
          background: req.gpt.background,
          outputFormat: req.gpt.outputFormat,
          outputCompression: req.gpt.outputCompression,
          frameCount: req.gpt.frameCount,
          frameDurationMs: req.gpt.frameDurationMs,
          n: req.n,
          ...modelField,
        };
        const res = hasImages
          ? await editGptImage(
              { ...common, images: req.images! },
              req.sessionChatId,
              req.usecase
            )
          : await generateGptImage(common, req.sessionChatId, req.usecase);
        return { s3Urls: res.images, chatId: res.chatId };
      }

      const res = await generateGeminiImage(
        {
          prompt: req.prompt,
          historyPrompt: req.historyPrompt,
          chatContext: req.chatContext,
          aspectRatio: req.gemini.aspectRatio,
          imageSize: req.gemini.imageSize,
          thinkingLevel: req.gemini.thinkingLevel,
          n: req.n,
          ...modelField,
          ...(hasImages ? { images: req.images } : {}),
        },
        req.sessionChatId,
        req.usecase
      );
      return { s3Urls: res.files, chatId: res.chatId };
    },
    [editGptImage, generateGptImage, generateGeminiImage]
  );

  return { renderImage };
};

export default useImageRender;
