// Fork custom: persist GPT Image results to S3 (fileBucket) and record
// them as a chat so they can be revisited from the chat history UI.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { ExtraData, GptImageInputImage } from 'generative-ai-use-cases';
import {
  createChat,
  setChatTitle,
  batchCreateMessages,
  findChatById,
} from '../repository';

const s3Client = new S3Client({});

// Matches the usecase path so the chat history sidebar shows the right icon
const USECASE = '/gpt-image';
const TITLE_MAX_LENGTH = 30;

const extensionOf = (mediaType: string): string => {
  if (mediaType.includes('jpeg')) return 'jpg';
  if (mediaType.includes('webp')) return 'webp';
  return 'png';
};

// Upload a base64 image to the file bucket and return the ExtraData
// entry referencing it. The URL format must be parseable by the
// frontend's parseS3Url (useFileApi.ts) so ChatMessage can resolve a
// signed URL: https://<bucket>.s3.<region>.amazonaws.com/<key>
const uploadImage = async (
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
    type: 'image',
    name: fileName,
    source: {
      type: 's3',
      mediaType,
      data: `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
    },
  };
};

// Upload input (edit source) and output images to S3.
// GPT Image outputs are PNG.
export const uploadGptImages = async (
  inputImages: GptImageInputImage[] | undefined,
  outputImages: string[]
): Promise<{ userExtraData: ExtraData[]; assistantExtraData: ExtraData[] }> => {
  const userExtraData = await Promise.all(
    (inputImages ?? []).map((image, i): Promise<ExtraData> => {
      // Reused generated images are already in the bucket — reference them
      // directly instead of re-uploading
      if (image.s3Url) {
        return Promise.resolve({
          type: 'image',
          name: image.s3Url.split('/').pop() ?? `input-${i + 1}.png`,
          source: {
            type: 's3',
            mediaType: image.mediaType,
            data: image.s3Url,
          },
        });
      }
      return uploadImage(
        image.data!,
        image.mediaType,
        `input-${i + 1}.${extensionOf(image.mediaType)}`
      );
    })
  );

  const assistantExtraData = await Promise.all(
    outputImages.map((base64, i) =>
      uploadImage(base64, 'image/png', `generated-${i + 1}.png`)
    )
  );

  return { userExtraData, assistantExtraData };
};

export const recordGptImageChat = async (params: {
  userId: string;
  prompt: string;
  // When set, the messages are appended to this existing chat (one
  // interactive session = one chat) instead of creating a new one
  existingChatId?: string;
  userExtraData: ExtraData[];
  assistantExtraData: ExtraData[];
}): Promise<string> => {
  const { userId, prompt, existingChatId, userExtraData, assistantExtraData } =
    params;

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
      USECASE
    );
    chatId = chat.chatId.replace('chat#', '');
  }

  await batchCreateMessages(
    [
      {
        role: 'user',
        content: prompt,
        messageId: uuidv4(),
        usecase: USECASE,
        ...(userExtraData.length > 0 ? { extraData: userExtraData } : {}),
      },
      {
        role: 'assistant',
        content: '',
        messageId: uuidv4(),
        usecase: USECASE,
        extraData: assistantExtraData,
      },
    ],
    userId,
    chatId
  );

  return chatId;
};
