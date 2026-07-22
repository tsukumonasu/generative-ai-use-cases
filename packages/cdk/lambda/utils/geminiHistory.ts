// Fork custom: persist Gemini generation results to S3 (fileBucket) and
// record them as a chat so they can be revisited from the chat history UI.
// Same pattern as gptImageHistory.ts, generalized to image + video media.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { ExtraData, GeminiInputMedia } from 'generative-ai-use-cases';
import { GeneratedMedia } from './geminiApi';
import {
  createChat,
  setChatTitle,
  batchCreateMessages,
  findChatById,
} from '../repository';

const s3Client = new S3Client({});

const TITLE_MAX_LENGTH = 30;

const extensionOf = (mediaType: string): string => {
  if (mediaType.includes('jpeg')) return 'jpg';
  if (mediaType.includes('webp')) return 'webp';
  if (mediaType.includes('mp4')) return 'mp4';
  if (mediaType.includes('webm')) return 'webm';
  return 'png';
};

const extraDataTypeOf = (mediaType: string): ExtraData['type'] =>
  mediaType.startsWith('video/') ? 'video' : 'image';

// Upload base64 media to the file bucket and return the ExtraData entry
// referencing it. The URL format must be parseable by the frontend's
// parseS3Url (useFileApi.ts) so ChatMessage can resolve a signed URL:
// https://<bucket>.s3.<region>.amazonaws.com/<key>
const uploadMedia = async (
  base64: string,
  mediaType: string,
  fileName: string
): Promise<ExtraData> => {
  const bucket = process.env.BUCKET_NAME!;
  const region = process.env.AWS_REGION!;
  const key = `${uuidv4()}/${fileName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(base64, 'base64'),
      ContentType: mediaType,
    })
  );

  return {
    type: extraDataTypeOf(mediaType),
    name: fileName,
    source: {
      type: 's3',
      mediaType,
      data: `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
    },
  };
};

// Upload input (edit source) and generated media to S3
export const uploadGeminiMedia = async (
  inputMedia: GeminiInputMedia[] | undefined,
  outputMedia: GeneratedMedia[]
): Promise<{ userExtraData: ExtraData[]; assistantExtraData: ExtraData[] }> => {
  const userExtraData = await Promise.all(
    (inputMedia ?? []).map((media, i): Promise<ExtraData> => {
      // Reused generated media is already in the bucket — reference it
      // directly instead of re-uploading
      if (media.s3Url) {
        return Promise.resolve({
          type: extraDataTypeOf(media.mediaType),
          name:
            media.s3Url.split('/').pop() ??
            `input-${i + 1}.${extensionOf(media.mediaType)}`,
          source: {
            type: 's3',
            mediaType: media.mediaType,
            data: media.s3Url,
          },
        });
      }
      return uploadMedia(
        media.data!,
        media.mediaType,
        `input-${i + 1}.${extensionOf(media.mediaType)}`
      );
    })
  );

  const assistantExtraData = await Promise.all(
    outputMedia.map((media, i) =>
      uploadMedia(
        media.data,
        media.mimeType,
        `generated-${i + 1}.${extensionOf(media.mimeType)}`
      )
    )
  );

  return { userExtraData, assistantExtraData };
};

export const recordGeminiChat = async (params: {
  userId: string;
  prompt: string;
  // Matches the route path so the chat history sidebar shows the right icon
  usecase: '/gemini-image' | '/gemini-video';
  // When set, the messages are appended to this existing chat (one
  // interactive session = one chat) instead of creating a new one
  existingChatId?: string;
  userExtraData: ExtraData[];
  assistantExtraData: ExtraData[];
}): Promise<string> => {
  const {
    userId,
    prompt,
    usecase,
    existingChatId,
    userExtraData,
    assistantExtraData,
  } = params;

  // Only append to a chat that exists and belongs to the requesting user
  let chatId =
    existingChatId && (await findChatById(userId, existingChatId))
      ? existingChatId
      : undefined;

  if (!chatId) {
    const chat = await createChat(userId);
    await setChatTitle(
      chat.id,
      chat.createdDate,
      prompt.slice(0, TITLE_MAX_LENGTH),
      usecase
    );
    chatId = chat.chatId.replace('chat#', '');
  }

  await batchCreateMessages(
    [
      {
        role: 'user',
        content: prompt,
        messageId: uuidv4(),
        usecase,
        ...(userExtraData.length > 0 ? { extraData: userExtraData } : {}),
      },
      {
        role: 'assistant',
        content: '',
        messageId: uuidv4(),
        usecase,
        extraData: assistantExtraData,
      },
    ],
    userId,
    chatId
  );

  return chatId;
};
