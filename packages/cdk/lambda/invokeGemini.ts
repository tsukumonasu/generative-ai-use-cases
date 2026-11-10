// Gemini image / video generation via the Google Gemini API,
// authenticated with Workload Identity Federation (no API key).
// Invoked directly from the frontend (IAM auth via Identity Pool) instead of
// going through API Gateway, to avoid the 29s integration timeout.
import {
  GeminiInvokeEvent,
  GeminiInputMedia,
  GenerateGeminiResponse,
  GenerateImageGeminiRequest,
  GenerateVideoGeminiRequest,
} from 'generative-ai-use-cases';
import {
  generateImageGemini,
  generateVideoGemini,
  GeneratedMedia,
} from './utils/geminiApi';
import { recordMediaChat, uploadMedia } from './utils/mediaHistory';
import { resolveS3Inputs, verifyMediaUser } from './utils/mediaInput';

export const handler = async (
  event: GeminiInvokeEvent
): Promise<GenerateGeminiResponse> => {
  // The function is invoked with IAM auth (Identity Pool authenticated role),
  // but the user identity for chat recording comes from the ID token.
  const userId = await verifyMediaUser(event.idToken);

  const req = event.request;
  if (!req?.prompt) {
    throw new Error('prompt is required');
  }

  let inputMedia: GeminiInputMedia[] | undefined;
  let outputMedia: GeneratedMedia[];
  let interactionId: string | undefined;

  if (event.mode === 'video') {
    const videoReq = req as GenerateVideoGeminiRequest;
    // Keep the original (possibly s3Url-based) inputs for history recording
    inputMedia = [...(videoReq.videos ?? []), ...(videoReq.images ?? [])];
    const res = await generateVideoGemini({
      ...videoReq,
      images: await resolveS3Inputs(videoReq.images ?? [], 'media'),
      videos: await resolveS3Inputs(videoReq.videos ?? [], 'media'),
    });
    outputMedia = res.videos;
    interactionId = res.interactionId;
  } else {
    const imageReq = req as GenerateImageGeminiRequest;
    inputMedia = imageReq.images;
    // A referenced chat transcript is prepended for the model call only —
    // the recorded chat history keeps just the user's own prompt
    const modelPrompt = imageReq.chatContext
      ? `${imageReq.chatContext}\n\n${imageReq.prompt}`
      : imageReq.prompt;
    outputMedia = await generateImageGemini({
      ...imageReq,
      prompt: modelPrompt,
      images: await resolveS3Inputs(imageReq.images ?? [], 'media'),
    });
  }

  const { userExtraData, assistantExtraData } = await uploadMedia(
    inputMedia,
    outputMedia
  );

  // Generation succeeded; a chat recording failure should not fail the request
  let chatId: string | undefined;
  try {
    chatId = await recordMediaChat({
      userId,
      // Pages with a long machine-oriented prompt record a readable label
      prompt: (req as GenerateImageGeminiRequest).historyPrompt || req.prompt,
      // The manga page reuses this Lambda (image mode) and records under its
      // own usecase. Only known values are accepted: the field comes from
      // the client.
      usecase:
        event.mode === 'video'
          ? '/gemini-video'
          : event.usecase === '/manga'
            ? '/manga'
            : '/gemini-image',
      existingChatId: event.chatId,
      userExtraData,
      assistantExtraData,
    });
  } catch (error) {
    console.log('Failed to save chat history:', error);
  }

  return {
    // S3 URLs of the generated media (resolved to signed URLs on the frontend)
    files: assistantExtraData.map((d) => d.source.data),
    chatId,
    interactionId,
  };
};
