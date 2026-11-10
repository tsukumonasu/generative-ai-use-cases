// The image / video models the image / video pages offer in their model
// selector. The deployment lists them (openAiImageModel(s), geminiImageModel(s)
// and geminiVideoModel(s) in cdk.json); the Lambdas accept only those.
import {
  DEFAULT_GEMINI_IMAGE_SIZES,
  GEMINI_MODEL_IMAGE_SIZES,
} from '@generative-ai-use-cases/common';

export type ImageProvider = 'gpt' | 'gemini';

// The image page (GPT Image and Gemini on one page) and the video page
export const IMAGE_STUDIO_PATHNAME = '/image-studio';
export const VIDEO_STUDIO_PATHNAME = '/gemini-video';

export type MediaModelOption = {
  // Unique among all providers, e.g. 'gemini:gemini-nano-banana-2.1'
  value: string;
  provider: ImageProvider;
  // '' = not sent: the Lambda uses its default (a build without the list)
  modelId: string;
  label: string;
};

export const gptImageEnabled: boolean =
  import.meta.env.VITE_APP_GPT_IMAGE_ENABLED === 'true';
export const geminiEnabled: boolean =
  import.meta.env.VITE_APP_GEMINI_ENABLED === 'true';

// Brand names, so not translated
const DISPLAY_NAMES: Record<string, string> = {
  'gpt-image-2.6-sunburst': 'GPT Image 2.6 Sunburst',
  'gpt-image-2.6-flare': 'GPT Image 2.6 Flare',
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
  'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'gpt-image-2': 'GPT Image 2',
  'gemini-nano-banana-2.1': 'Nano Banana 2.1',
  'gemini-3-pro-image': 'Nano Banana Pro',
  'gemini-3.1-flash-image': 'Nano Banana 2',
  'gemini-3.1-flash-lite-image': 'Nano Banana 2 Lite',
  'gemini-2.5-flash-image': 'Nano Banana',
  'gemini-omni-1.2-flash': 'Gemini Omni 1.2 Flash',
  'gemini-omni-1.1-flash': 'Gemini Omni 1.1 Flash',
};

const PROVIDER_NAMES: Record<ImageProvider, string> = {
  gpt: 'GPT Image',
  gemini: 'Gemini',
};

export const mediaModelDisplayName = (
  provider: ImageProvider,
  modelId: string
): string =>
  modelId ? (DISPLAY_NAMES[modelId] ?? modelId) : PROVIDER_NAMES[provider];

const parseModels = (enabled: boolean, json: string | undefined): string[] => {
  if (!enabled) return [];
  try {
    const parsed = JSON.parse(json || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((m): m is string => typeof m === 'string');
    }
  } catch {
    // Fall through to the default model
  }
  return [''];
};

const toOptions = (
  provider: ImageProvider,
  modelIds: string[]
): MediaModelOption[] =>
  modelIds.map((modelId) => ({
    value: `${provider}:${modelId}`,
    provider,
    modelId,
    label: mediaModelDisplayName(provider, modelId),
  }));

// Gemini first, so it is the default when both providers are enabled
export const IMAGE_MODELS: MediaModelOption[] = [
  ...toOptions(
    'gemini',
    parseModels(geminiEnabled, import.meta.env.VITE_APP_GEMINI_IMAGE_MODELS)
  ),
  ...toOptions(
    'gpt',
    parseModels(gptImageEnabled, import.meta.env.VITE_APP_GPT_IMAGE_MODELS)
  ),
];

export const VIDEO_MODELS: MediaModelOption[] = toOptions(
  'gemini',
  parseModels(geminiEnabled, import.meta.env.VITE_APP_GEMINI_VIDEO_MODELS)
);

export const findMediaModel = (
  models: MediaModelOption[],
  value: string
): MediaModelOption | undefined => models.find((m) => m.value === value);

// Image sizes each Gemini image model accepts. The table is shared with the
// Lambda (packages/common), which clamps other sizes. A model not listed there
// gets the sizes of the current models here, while the Lambda passes the
// requested size through unchanged for it.
export const geminiImageSizes = (modelId: string): string[] =>
  GEMINI_MODEL_IMAGE_SIZES[modelId] ?? DEFAULT_GEMINI_IMAGE_SIZES;
