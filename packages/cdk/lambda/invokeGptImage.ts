// Fork custom: GPT Image (OpenAI Images API) generation / editing.
// Invoked directly from the frontend (IAM auth via Identity Pool) instead of
// going through API Gateway, to avoid the 29s integration timeout.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  GptImageInvokeEvent,
  GptImageInputImage,
  GenerateImageGptResponse,
  EditImageGptRequest,
} from 'generative-ai-use-cases';
import { generateImageGpt, editImageGpt } from './utils/gptImageApi';
import { uploadGptImages, recordGptImageChat } from './utils/gptImageHistory';

const s3Client = new S3Client({});

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

// Inputs referencing a previously generated image arrive as S3 URLs
// (to keep the invoke payload small) — download and convert to base64.
// Only URLs pointing at our own file bucket are allowed.
const resolveInputImages = async (
  images: GptImageInputImage[]
): Promise<GptImageInputImage[]> => {
  const bucket = process.env.BUCKET_NAME!;
  const keyPattern = new RegExp(
    `^https://${bucket}\\.s3\\.[a-z0-9-]+\\.amazonaws\\.com/(?<key>.+)$`
  );

  return Promise.all(
    images.map(async (image) => {
      if (!image.s3Url) {
        if (!image.data) {
          throw new Error('Each input image must have either data or s3Url');
        }
        return image;
      }

      const key = keyPattern.exec(image.s3Url)?.groups?.key;
      if (!key) {
        throw new Error('Invalid input image S3 URL');
      }

      const res = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) })
      );
      const bytes = await res.Body!.transformToByteArray();
      return { ...image, data: Buffer.from(bytes).toString('base64') };
    })
  );
};

export const handler = async (
  event: GptImageInvokeEvent
): Promise<GenerateImageGptResponse> => {
  // The function is invoked with IAM auth (Identity Pool authenticated role),
  // but the user identity for chat recording comes from the ID token.
  const payload = await verifier.verify(event.idToken ?? '');
  const userId = payload['cognito:username'] as string;

  const req = event.request;
  if (!req?.prompt) {
    throw new Error('prompt is required');
  }

  let inputImages: GptImageInputImage[] | undefined;
  let res;

  if (event.mode === 'edit') {
    const editReq = req as EditImageGptRequest;
    // Keep the original (possibly s3Url-based) inputs for history recording
    inputImages = editReq.images;
    const resolvedImages = await resolveInputImages(editReq.images ?? []);
    res = await editImageGpt({ ...editReq, images: resolvedImages });
  } else {
    res = await generateImageGpt(req);
  }

  const { userExtraData, assistantExtraData } = await uploadGptImages(
    inputImages,
    res.images
  );

  // Generation succeeded; a chat recording failure should not fail the request
  let chatId: string | undefined;
  try {
    chatId = await recordGptImageChat({
      userId,
      prompt: req.prompt,
      existingChatId: event.chatId,
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
