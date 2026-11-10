// The generation parameters each image / video model accepts.
// Like geminiImage.ts, the single source for both sides:
//   - the web offers only these values in its settings
//   - the Lambdas replace anything else by a supported value (or leave the
//     parameter out), so a stale browser tab cannot cause a 400
// Sources: https://ai.google.dev/gemini-api/docs/omni,
// https://ai.google.dev/gemini-api/docs/image-generation and the OpenAI
// Images API reference (generate / edit), as of 2026-11.

// ---------- Gemini video (Gemini Omni Flash, interactions API) ----------

export const GEMINI_VIDEO_ASPECT_RATIOS: string[] = ['16:9', '9:16'];

// 360p / 720p are generated; 1080p / 4k are upscaled from them
export const GEMINI_VIDEO_RESOLUTIONS: string[] = [
  '360p',
  '720p',
  '1080p',
  '4k',
];
export const DEFAULT_GEMINI_VIDEO_RESOLUTION = '720p';

// Whole seconds. Omni 1.2 raised the maximum from 10 to 15.
export const GEMINI_VIDEO_MIN_DURATION = 3;
export const DEFAULT_GEMINI_VIDEO_DURATION = 10;
const GEMINI_VIDEO_MAX_DURATIONS: Record<string, number> = {
  'gemini-omni-1.1-flash': 10,
};
const DEFAULT_GEMINI_VIDEO_MAX_DURATION = 15;

export const geminiVideoMaxDuration = (modelId: string): number =>
  GEMINI_VIDEO_MAX_DURATIONS[modelId] ?? DEFAULT_GEMINI_VIDEO_MAX_DURATION;

// The durations (seconds) the model accepts, shortest first
export const geminiVideoDurations = (modelId: string): number[] => {
  const max = geminiVideoMaxDuration(modelId);
  const durations: number[] = [];
  for (let s = GEMINI_VIDEO_MIN_DURATION; s <= max; s++) {
    durations.push(s);
  }
  return durations;
};

export const clampGeminiVideoDuration = (
  modelId: string,
  seconds: number
): number =>
  Math.min(
    Math.max(Math.round(seconds), GEMINI_VIDEO_MIN_DURATION),
    geminiVideoMaxDuration(modelId)
  );

// ---------- Gemini image (Nano Banana family) ----------

const GEMINI_IMAGE_ASPECT_RATIOS: string[] = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
];
// Banner-like ratios only the newer flash models draw
const GEMINI_IMAGE_EXTREME_ASPECT_RATIOS: string[] = [
  '4:1',
  '1:4',
  '8:1',
  '1:8',
];
const GEMINI_EXTREME_ASPECT_RATIO_MODELS: string[] = [
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image',
];

export const geminiImageAspectRatios = (modelId: string): string[] =>
  GEMINI_EXTREME_ASPECT_RATIO_MODELS.includes(modelId)
    ? [...GEMINI_IMAGE_ASPECT_RATIOS, ...GEMINI_IMAGE_EXTREME_ASPECT_RATIOS]
    : GEMINI_IMAGE_ASPECT_RATIOS;

// Thinking levels a model lets the caller pick (weakest first). A model
// that is not listed has no choice: Nano Banana Pro always thinks, the
// older ones never do, so the parameter is not sent for them.
const GEMINI_IMAGE_THINKING_LEVELS: Record<string, string[]> = {
  'gemini-nano-banana-2.1': ['minimal', 'medium', 'high'],
  'gemini-3.1-flash-image': ['minimal', 'high'],
  'gemini-3.1-flash-lite-image': ['minimal', 'high'],
};

export const geminiImageThinkingLevels = (modelId: string): string[] =>
  GEMINI_IMAGE_THINKING_LEVELS[modelId] ?? [];

// ---------- GPT Image (OpenAI Images API) ----------

const GPT_IMAGE_STANDARD_SIZES: string[] = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
];
// Free WIDTHxHEIGHT sizes (both divisible by 16, ratio within 1:3 - 3:1, up
// to 3840x2160) are documented for these models only; the page offers the
// 16:9 ones the standard sizes lack
const GPT_IMAGE_CUSTOM_SIZES: string[] = [
  '1536x864',
  '864x1536',
  '2560x1440',
  '1440x2560',
  '3840x2160',
];
const GPT_IMAGE_CUSTOM_SIZE_MODELS: string[] = [
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
];

export const gptImageSizes = (modelId: string): string[] =>
  GPT_IMAGE_CUSTOM_SIZE_MODELS.includes(modelId)
    ? [...GPT_IMAGE_STANDARD_SIZES, ...GPT_IMAGE_CUSTOM_SIZES]
    : GPT_IMAGE_STANDARD_SIZES;

const GPT_IMAGE_QUALITIES: string[] = ['auto', 'low', 'medium', 'high'];
const GPT_IMAGE_EXTRA_QUALITIES: string[] = ['xhigh', 'max'];
const GPT_IMAGE_EXTRA_QUALITY_MODELS: string[] = [
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
];

export const gptImageQualities = (modelId: string): string[] =>
  GPT_IMAGE_EXTRA_QUALITY_MODELS.includes(modelId)
    ? [...GPT_IMAGE_QUALITIES, ...GPT_IMAGE_EXTRA_QUALITIES]
    : GPT_IMAGE_QUALITIES;

export const GPT_IMAGE_BACKGROUNDS: string[] = [
  'auto',
  'opaque',
  'transparent',
];

// gif = a short animation (the API account needs GIF preview access)
export const GPT_IMAGE_OUTPUT_FORMATS: string[] = [
  'png',
  'jpeg',
  'webp',
  'gif',
];

// A transparent background needs PNG or WebP
const GPT_IMAGE_TRANSPARENT_FORMATS: string[] = ['png', 'webp'];

export const gptImageOutputFormats = (background: string): string[] =>
  background === 'transparent'
    ? GPT_IMAGE_TRANSPARENT_FORMATS
    : GPT_IMAGE_OUTPUT_FORMATS;

// GIF animation: number of frames and how long each one is shown
export const GPT_IMAGE_GIF_MIN_FRAMES = 2;
export const GPT_IMAGE_GIF_MAX_FRAMES = 16;
export const DEFAULT_GPT_IMAGE_GIF_FRAMES = 9;
export const GPT_IMAGE_GIF_MIN_FRAME_DURATION_MS = 20;
export const DEFAULT_GPT_IMAGE_GIF_FRAME_DURATION_MS = 200;
// What the page offers (the API takes any value from the minimum up)
export const GPT_IMAGE_GIF_FRAME_DURATIONS_MS: number[] = [
  50, 100, 200, 300, 500, 1000,
];

// output_compression applies to the lossy formats only
export const gptImageHasCompression = (outputFormat: string): boolean =>
  outputFormat === 'jpeg' || outputFormat === 'webp';
