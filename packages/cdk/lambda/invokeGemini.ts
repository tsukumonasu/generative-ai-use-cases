// Fork custom: Gemini image / video generation via the Google Gemini API,
// authenticated with Workload Identity Federation (no API key).
// Invoked directly from the frontend (IAM auth via Identity Pool) instead of
// going through API Gateway, to avoid the 29s integration timeout.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
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
import { uploadGeminiMedia, recordGeminiChat } from './utils/geminiHistory';

const s3Client = new S3Client({});

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

// Inputs referencing previously generated media arrive as S3 URLs
// (to keep the invoke payload small) — download and convert to base64.
// Only URLs pointing at our own file bucket are allowed.
const resolveInputMedia = async (
  media: GeminiInputMedia[]
): Promise<GeminiInputMedia[]> => {
  const bucket = process.env.BUCKET_NAME!;
  const keyPattern = new RegExp(
    `^https://${bucket}\\.s3\\.[a-z0-9-]+\\.amazonaws\\.com/(?<key>.+)$`
  );

  return Promise.all(
    media.map(async (item) => {
      if (!item.s3Url) {
        if (!item.data) {
          throw new Error('Each input media must have either data or s3Url');
        }
        return item;
      }

      const key = keyPattern.exec(item.s3Url)?.groups?.key;
      if (!key) {
        throw new Error('Invalid input media S3 URL');
      }

      const res = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) })
      );
      const bytes = await res.Body!.transformToByteArray();
      return { ...item, data: Buffer.from(bytes).toString('base64') };
    })
  );
};

export const handler = async (
  event: GeminiInvokeEvent
): Promise<GenerateGeminiResponse> => {
  // The function is invoked with IAM auth (Identity Pool authenticated role),
  // but the user identity for chat recording comes from the ID token.
  const payload = await verifier.verify(event.idToken ?? '');
  const userId = payload['cognito:username'] as string;

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
      images: await resolveInputMedia(videoReq.images ?? []),
      videos: await resolveInputMedia(videoReq.videos ?? []),
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
      images: await resolveInputMedia(imageReq.images ?? []),
    });
  }

  const { userExtraData, assistantExtraData } = await uploadGeminiMedia(
    inputMedia,
    outputMedia
  );

  // Generation succeeded; a chat recording failure should not fail the request
  let chatId: string | undefined;
  try {
    chatId = await recordGeminiChat({
      userId,
      prompt: req.prompt,
      usecase: event.mode === 'video' ? '/gemini-video' : '/gemini-image',
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
