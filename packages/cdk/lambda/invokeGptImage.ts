// GPT Image (OpenAI Images API) generation / editing.
// Invoked directly from the frontend (IAM auth via Identity Pool) instead of
// going through API Gateway, to avoid the 29s integration timeout.
import {
  GptImageInvokeEvent,
  GptImageInputImage,
  GenerateImageGptResponse,
  EditImageGptRequest,
} from 'generative-ai-use-cases';
import {
  generateImageGpt,
  editImageGpt,
  gptImageOutputMimeType,
} from './utils/gptImageApi';
import { recordMediaChat, uploadMedia } from './utils/mediaHistory';
import { resolveS3Inputs, verifyMediaUser } from './utils/mediaInput';

export const handler = async (
  event: GptImageInvokeEvent
): Promise<GenerateImageGptResponse> => {
  // The function is invoked with IAM auth (Identity Pool authenticated role),
  // but the user identity for chat recording comes from the ID token.
  const userId = await verifyMediaUser(event.idToken);

  const req = event.request;
  if (!req?.prompt) {
    throw new Error('prompt is required');
  }

  // A referenced chat transcript is prepended for the model call only —
  // the recorded chat history keeps just the user's own prompt
  const modelPrompt = req.chatContext
    ? `${req.chatContext}\n\n${req.prompt}`
    : req.prompt;

  let inputImages: GptImageInputImage[] | undefined;
  let res;

  if (event.mode === 'edit') {
    const editReq = req as EditImageGptRequest;
    // Keep the original (possibly s3Url-based) inputs for history recording
    inputImages = editReq.images;
    const resolvedImages = await resolveS3Inputs(editReq.images ?? [], 'image');
    res = await editImageGpt({
      ...editReq,
      prompt: modelPrompt,
      images: resolvedImages,
    });
  } else {
    res = await generateImageGpt({ ...req, prompt: modelPrompt });
  }

  const { userExtraData, assistantExtraData } = await uploadMedia(
    inputImages,
    // PNG unless the request asked for another output format
    res.images.map((data) => ({ data, mimeType: gptImageOutputMimeType(req) }))
  );

  // Generation succeeded; a chat recording failure should not fail the request
  let chatId: string | undefined;
  try {
    chatId = await recordMediaChat({
      userId,
      prompt: req.prompt,
      existingChatId: event.chatId,
      usecase: '/gpt-image',
      userExtraData,
      assistantExtraData,
    });
  } catch (error) {
    console.log('Failed to save chat history:', error);
  }

  return {
    // S3 URLs of the generated images (resolved to signed URLs on the frontend)
    images: assistantExtraData.map((d) => d.source.data),
    chatId,
  };
};
