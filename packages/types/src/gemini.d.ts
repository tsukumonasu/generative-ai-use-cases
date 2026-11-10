// Gemini (Google Gemini API) image / video generation.
// Authentication is Workload Identity Federation (no API key) — see
// docs/en/DEPLOY_GEMINI_GPT_IMAGE.md for the Google-side setup.

export type GeminiMode = 'image' | 'video';

// Image sizes supported by the Gemini image models (Nano Banana family).
// Supported values depend on the model; the backend clamps unsupported
// values to the nearest supported one.
export type GeminiImageSize = '512' | '1K' | '2K' | '4K';

// How much the image model plans before drawing. The levels a model offers
// are listed in packages/common (mediaParams.ts); the backend leaves the
// parameter out for a model that does not offer the requested one.
export type GeminiImageThinkingLevel = 'minimal' | 'medium' | 'high';

// Output resolution of the video model (1080p / 4k are upscaled)
export type GeminiVideoResolution = '360p' | '720p' | '1080p' | '4k';

// Video tasks of the interactions endpoint (Gemini Omni Flash).
// When omitted the model infers the task from the prompt and inputs.
export type GeminiVideoTask =
  | 'text_to_video'
  | 'image_to_video'
  | 'reference_to_video'
  | 'edit';

export type GeminiInputMedia = {
  // Base64 encoded media data (without data URI prefix).
  // Either data or s3Url must be set.
  data?: string;
  // S3 URL of media already in the file bucket — used when reusing a
  // previously generated image/video for further editing (keeps the
  // direct-invoke payload small; resolved to bytes server-side)
  s3Url?: string;
  mediaType: string;
};

export type GenerateImageGeminiRequest = {
  prompt: string;
  // Transcript of a referenced chat conversation. Prepended to the prompt
  // for the model call only — the recorded chat history keeps just prompt
  chatContext?: string;
  // Human-readable label recorded in the chat history in place of prompt.
  // The mirror of chatContext: used when the prompt sent to the model is
  // long and machine-oriented (the manga page composes one per page)
  historyPrompt?: string;
  aspectRatio?: string;
  imageSize?: GeminiImageSize;
  // Omitted = the model's own default
  thinkingLevel?: GeminiImageThinkingLevel;
  n?: number;
  // Model picked on the page; one the deployment does not offer
  // (geminiImageModels in cdk.json) is replaced by the default model
  model?: string;
  // Source images for editing (optional; when set the model edits /
  // references them)
  images?: GeminiInputMedia[];
};

export type GenerateVideoGeminiRequest = {
  prompt: string;
  // 16:9 (default) or 9:16
  aspectRatio?: string;
  // 360p / 720p (default) / 1080p / 4k
  resolution?: GeminiVideoResolution;
  // Length in whole seconds: 3 to 15 (10 with Omni 1.1), default 10. The
  // backend clamps it to what the model accepts.
  // aspectRatio, resolution and duration apply to new videos only — an edit
  // inherits them from its source video (the API rejects them there).
  duration?: number;
  task?: GeminiVideoTask;
  // Model picked on the page; one the deployment does not offer
  // (geminiVideoModels in cdk.json) is replaced by the default model
  model?: string;
  // Reference images (image_to_video / reference_to_video)
  images?: GeminiInputMedia[];
  // Input videos for video-to-video editing (normally one)
  videos?: GeminiInputMedia[];
  // Interaction ID of a previous generation for stateful editing
  // (edits the previous result without re-uploading it)
  previousInteractionId?: string;
};

export type GenerateGeminiResponse = {
  // S3 URLs of the generated media
  // (https://<bucket>.s3.<region>.amazonaws.com/<key>)
  files: string[];
  // Chat ID of the automatically recorded chat history entry
  // (undefined if recording failed)
  chatId?: string;
  // Interaction ID returned by the video interactions endpoint —
  // pass back as previousInteractionId for stateful editing
  interactionId?: string;
};

// Payload for direct Lambda invocation (bypasses API Gateway to avoid
// its 29s integration timeout)
export type GeminiInvokeEvent = {
  mode: GeminiMode;
  // Cognito ID token; appended by the frontend, verified server-side
  idToken?: string;
  request: GenerateImageGeminiRequest | GenerateVideoGeminiRequest;
  // Chat ID of an ongoing interactive session — when set, the generation
  // is appended to this chat instead of creating a new one
  chatId?: string;
  // Usecase path the generation is recorded under in the chat history
  // (drives the history sidebar icon). Defaults to the mode's own page;
  // pages that reuse this Lambda (the manga page) override it.
  usecase?: '/gemini-image' | '/gemini-video' | '/manga';
};
