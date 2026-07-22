// Fork custom: OpenAI Images API (GPT Image) client
// Called from the /gpt-image/* routes. Uses the OPENAI_API_KEY and
// OPENAI_IMAGE_MODEL environment variables injected by the Api construct.

import {
  GenerateImageGptRequest,
  EditImageGptRequest,
  GenerateImageGptResponse,
  GptImageInputImage,
} from 'generative-ai-use-cases';

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

const getImageModel = (): string => {
  return process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
};

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

export const generateImageGpt = async (
  req: GenerateImageGptRequest
): Promise<GenerateImageGptResponse> => {
  const res = await fetch(`${OPENAI_API_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: getImageModel(),
      prompt: req.prompt,
      n: clampN(req.n),
      ...(req.size && req.size !== 'auto' ? { size: req.size } : {}),
      ...(req.quality && req.quality !== 'auto'
        ? { quality: req.quality }
        : {}),
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
  form.append('model', getImageModel());
  form.append('prompt', req.prompt);
  form.append('n', String(clampN(req.n)));
  if (req.size && req.size !== 'auto') {
    form.append('size', req.size);
  }
  if (req.quality && req.quality !== 'auto') {
    form.append('quality', req.quality);
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
