// Fork custom: GPT Image (OpenAI Images API) generation / editing

export type GptImageMode = 'generate' | 'edit';

export type GptImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';

export type GptImageQuality = 'auto' | 'low' | 'medium' | 'high';

export type GptImageInputImage = {
  // Base64 encoded image data (without data URI prefix).
  // Either data or s3Url must be set.
  data?: string;
  // S3 URL of an image already in the file bucket — used when reusing a
  // previously generated image for further editing (keeps the direct-invoke
  // payload small; resolved to bytes server-side)
  s3Url?: string;
  mediaType: string;
};

export type GenerateImageGptRequest = {
  prompt: string;
  // Transcript of a referenced chat conversation. Prepended to the prompt
  // for the model call only — the recorded chat history keeps just prompt
  chatContext?: string;
  size?: GptImageSize;
  quality?: GptImageQuality;
  n?: number;
};

export type EditImageGptRequest = GenerateImageGptRequest & {
  // Source images to edit (1 or more)
  images: GptImageInputImage[];
  // Optional mask image (transparent area is edited)
  mask?: GptImageInputImage;
};

export type GenerateImageGptResponse = {
  // S3 URLs of the generated images
  // (https://<bucket>.s3.<region>.amazonaws.com/<key>)
  images: string[];
  // Chat ID of the automatically recorded chat history entry
  // (undefined if recording failed)
  chatId?: string;
};

// Payload for direct Lambda invocation (bypasses API Gateway to avoid
// its 29s integration timeout)
export type GptImageInvokeEvent = {
  mode: GptImageMode;
  // Cognito ID token; appended by the frontend, verified server-side
  idToken?: string;
  request: GenerateImageGptRequest | EditImageGptRequest;
  // Chat ID of an ongoing interactive session — when set, the generation
  // is appended to this chat instead of creating a new one
  chatId?: string;
};
