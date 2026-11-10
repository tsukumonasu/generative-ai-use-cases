// OpenAI Images API (GPT Image) client
// Called from the /gpt-image/* routes. Uses the OPENAI_API_KEY,
// OPENAI_IMAGE_MODEL (default) and OPENAI_IMAGE_MODELS (models the user may
// pick) environment variables injected by the Api construct.

import {
  GenerateImageGptRequest,
  EditImageGptRequest,
  GenerateImageGptResponse,
  GptImageInputImage,
} from 'generative-ai-use-cases';
import {
  GPT_IMAGE_BACKGROUNDS,
  GPT_IMAGE_GIF_MAX_FRAMES,
  GPT_IMAGE_GIF_MIN_FRAMES,
  GPT_IMAGE_GIF_MIN_FRAME_DURATION_MS,
  GPT_IMAGE_OUTPUT_FORMATS,
  gptImageOutputFormats,
  gptImageHasCompression,
  gptImageQualities,
  gptImageSizes,
} from '@generative-ai-use-cases/common';
import { pickMediaModel } from './mediaModel';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

// Keep the total response size within the API Gateway limit (10MB)
const MAX_IMAGES_PER_REQUEST = 4;

const getApiKey = (): string => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Set openAiApiKey in cdk.json (or parameter.ts) and redeploy.'
    );
  }
  return apiKey;
};

// The model the user picked, when the deployment offers it (OPENAI_IMAGE_MODELS)
const getImageModel = (requested?: string): string =>
  pickMediaModel(
    requested,
    process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.6-sunburst',
    process.env.OPENAI_IMAGE_MODELS
  );

type OpenAiImageResponse = {
  data?: { b64_json?: string }[];
  error?: { message?: string };
};

const extractImages = async (res: Response): Promise<string[]> => {
  const body = (await res.json()) as OpenAiImageResponse;

  if (!res.ok) {
    throw new Error(
      `OpenAI Images API error (${res.status}): ${body.error?.message ?? 'Unknown error'}`
    );
  }

  const images = (body.data ?? [])
    .map((d) => d.b64_json)
    .filter((b): b is string => !!b);

  if (images.length === 0) {
    throw new Error('OpenAI Images API returned no image data');
  }

  return images;
};

const clampN = (n?: number): number => {
  return Math.min(Math.max(n ?? 1, 1), MAX_IMAGES_PER_REQUEST);
};

const toBlob = (image: GptImageInputImage): Blob => {
  if (!image.data) {
    // s3Url inputs are resolved to data before reaching this module
    throw new Error('image data is missing');
  }
  return new Blob([Buffer.from(image.data, 'base64')], {
    type: image.mediaType,
  });
};

const fileNameOf = (image: GptImageInputImage, index: number): string => {
  const ext = image.mediaType.includes('jpeg')
    ? 'jpg'
    : image.mediaType.includes('webp')
      ? 'webp'
      : 'png';
  return `image-${index}.${ext}`;
};

// The output format actually requested from the API: a transparent
// background cannot be a JPEG or a GIF, so those combinations become PNG
const outputFormatOf = (req: GenerateImageGptRequest): string => {
  const format =
    req.outputFormat && GPT_IMAGE_OUTPUT_FORMATS.includes(req.outputFormat)
      ? req.outputFormat
      : 'png';
  return gptImageOutputFormats(req.background ?? 'auto').includes(format)
    ? format
    : 'png';
};

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// Media type of the images the API returns for this request (they are
// stored in S3 under it)
export const gptImageOutputMimeType = (req: GenerateImageGptRequest): string =>
  `image/${outputFormatOf(req)}`;

// The optional parameters of both endpoints, as API field -> value. Values
// the model does not offer are left out, so the API default applies
// ('auto' is the default of size / quality / background, png of the format).
const optionalParams = (
  model: string,
  req: GenerateImageGptRequest
): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (
    req.size &&
    req.size !== 'auto' &&
    gptImageSizes(model).includes(req.size)
  ) {
    params.size = req.size;
  }
  if (
    req.quality &&
    req.quality !== 'auto' &&
    gptImageQualities(model).includes(req.quality)
  ) {
    params.quality = req.quality;
  }
  if (
    req.background &&
    req.background !== 'auto' &&
    GPT_IMAGE_BACKGROUNDS.includes(req.background)
  ) {
    params.background = req.background;
  }
  const format = outputFormatOf(req);
  if (format !== 'png') {
    params.output_format = format;
  }
  if (gptImageHasCompression(format) && isNumber(req.outputCompression)) {
    params.output_compression = Math.min(
      Math.max(Math.round(req.outputCompression), 0),
      100
    );
  }
  // GIF animation (left out = 9 frames of 200ms)
  if (format === 'gif') {
    if (isNumber(req.frameCount)) {
      params.frame_count = Math.min(
        Math.max(Math.round(req.frameCount), GPT_IMAGE_GIF_MIN_FRAMES),
        GPT_IMAGE_GIF_MAX_FRAMES
      );
    }
    if (isNumber(req.frameDurationMs)) {
      params.frame_duration_ms = Math.max(
        Math.round(req.frameDurationMs),
        GPT_IMAGE_GIF_MIN_FRAME_DURATION_MS
      );
    }
  }
  return params;
};

export const generateImageGpt = async (
  req: GenerateImageGptRequest
): Promise<GenerateImageGptResponse> => {
  const model = getImageModel(req.model);
  const res = await fetch(`${OPENAI_API_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      n: clampN(req.n),
      ...optionalParams(model, req),
    }),
  });

  return { images: await extractImages(res) };
};

export const editImageGpt = async (
  req: EditImageGptRequest
): Promise<GenerateImageGptResponse> => {
  if (!req.images || req.images.length === 0) {
    throw new Error('At least one input image is required for editing');
  }

  const form = new FormData();
  const model = getImageModel(req.model);
  form.append('model', model);
  form.append('prompt', req.prompt);
  form.append('n', String(clampN(req.n)));
  for (const [key, value] of Object.entries(optionalParams(model, req))) {
    form.append(key, String(value));
  }
  for (const [index, image] of req.images.entries()) {
    form.append('image[]', toBlob(image), fileNameOf(image, index));
  }
  if (req.mask) {
    form.append('mask', toBlob(req.mask), fileNameOf(req.mask, 99));
  }

  const res = await fetch(`${OPENAI_API_BASE}/images/edits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: form,
  });

  return { images: await extractImages(res) };
};
