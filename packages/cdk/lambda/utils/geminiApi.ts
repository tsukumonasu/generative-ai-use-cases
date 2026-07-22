// Fork custom: Gemini image / video generation API client.
// Image: Vertex AI (aiplatform.googleapis.com) generateContent with the
//        Gemini image models (Nano Banana family).
// Video: Gemini API (generativelanguage.googleapis.com) interactions
//        endpoint with Gemini Omni Flash.
// Authenticated with a Workload Identity Federation access token
// (utils/googleAuth.ts) — no API key.

import { request } from 'node:https';
import {
  GenerateImageGeminiRequest,
  GenerateVideoGeminiRequest,
  GeminiInputMedia,
} from 'generative-ai-use-cases';
import { getGoogleAccessToken } from './googleAuth';

const AIPLATFORM_HOST = 'https://aiplatform.googleapis.com';
const GEMINI_API_HOST = 'https://generativelanguage.googleapis.com';

// Keep the total response size within the direct-invoke payload limit
const MAX_IMAGES_PER_REQUEST = 4;

export type GeneratedMedia = {
  mimeType: string;
  data: string; // base64
};

const getProjectId = (): string => {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'GOOGLE_PROJECT_ID is not configured. Set geminiProjectId in cdk.json and redeploy.'
    );
  }
  return projectId;
};

// Image sizes supported per model — unsupported values are clamped to the
// nearest supported one to avoid a 400 INVALID_ARGUMENT.
//   gemini-3.1-flash-lite-image (Nano Banana 2 Lite): 1K only
//   gemini-3.1-flash-image      (Nano Banana 2)     : 512 / 1K / 2K / 4K
//   gemini-3-pro-image          (Nano Banana Pro)   : 1K / 2K / 4K
//   gemini-2.5-flash-image      (Nano Banana)       : 1K only
const MODEL_IMAGE_SIZES: Record<string, string[]> = {
  'gemini-3.1-flash-lite-image': ['1K'],
  'gemini-3.1-flash-image': ['512', '1K', '2K', '4K'],
  'gemini-3-pro-image': ['1K', '2K', '4K'],
  'gemini-2.5-flash-image': ['1K'],
};
const SIZE_RANK: Record<string, number> = {
  '512': 0,
  '1K': 1,
  '2K': 2,
  '4K': 3,
};

const clampImageSize = (model: string, requested: string): string => {
  const allowed = MODEL_IMAGE_SIZES[model];
  if (!allowed || allowed.includes(requested)) {
    return requested;
  }
  const requestedRank = SIZE_RANK[requested] ?? SIZE_RANK['1K'];
  const lowerOrEqual = allowed.filter((s) => SIZE_RANK[s] <= requestedRank);
  const pool = lowerOrEqual.length > 0 ? lowerOrEqual : allowed;
  return pool.reduce((a, b) => (SIZE_RANK[a] >= SIZE_RANK[b] ? a : b), pool[0]);
};

// The video interactions call can take many minutes; the global fetch
// (undici) times out waiting for response headers after 300s, so use
// node:https with no timeout (bounded by the Lambda timeout instead).
const postJson = (
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; body: string }> => {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
};

const throwApiError = (
  endpoint: string,
  status: number,
  body: string
): never => {
  let message = body.slice(0, 800);
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message ?? message;
  } catch {
    // keep the raw body
  }
  if (status === 429) {
    throw new Error(`Rate limit exceeded on ${endpoint} (429): ${message}`);
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `Authentication / permission error on ${endpoint} (${status}): ${message}. ` +
        'Check the Workload Identity Federation setup, the service account roles, ' +
        'and that the API is enabled in the Google Cloud project (docs/ja/DEPLOY_GEMINI_GPT_IMAGE.md).'
    );
  }
  throw new Error(`${endpoint} request failed (${status}): ${message}`);
};

// ---------- Image (aiplatform generateContent) ----------

type GenerateContentResponse = {
  candidates?: {
    finishReason?: string;
    content?: {
      parts?: { inlineData?: { mimeType?: string; data?: string } }[];
    };
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

export const generateImageGemini = async (
  req: GenerateImageGeminiRequest
): Promise<GeneratedMedia[]> => {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const location = process.env.GEMINI_IMAGE_LOCATION || 'global';
  const url =
    `${AIPLATFORM_HOST}/v1/projects/${getProjectId()}/locations/${location}` +
    `/publishers/google/models/${model}:generateContent`;

  const parts: unknown[] = (req.images ?? []).map((image) => ({
    inlineData: { mimeType: image.mediaType, data: image.data },
  }));
  parts.push({ text: req.prompt });

  const token = await getGoogleAccessToken();
  const { status, body } = await postJson(
    url,
    { Authorization: `Bearer ${token}` },
    {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: req.aspectRatio || '1:1',
          imageSize: clampImageSize(model, req.imageSize || '1K'),
        },
        candidateCount: Math.min(
          Math.max(req.n ?? 1, 1),
          MAX_IMAGES_PER_REQUEST
        ),
      },
    }
  );

  if (status !== 200) {
    throwApiError('Gemini image API', status, body);
  }

  const res = JSON.parse(body) as GenerateContentResponse;
  if (res.promptFeedback?.blockReason) {
    throw new Error(
      `Blocked by safety filter: ${res.promptFeedback.blockReason}`
    );
  }

  const images: GeneratedMedia[] = [];
  for (const candidate of res.candidates ?? []) {
    if (candidate.finishReason === 'SAFETY') {
      continue;
    }
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        images.push({
          mimeType: part.inlineData.mimeType ?? 'image/png',
          data: part.inlineData.data,
        });
      }
    }
  }
  if (images.length === 0) {
    throw new Error('Gemini image API returned no image data');
  }
  return images;
};

// ---------- Video (generativelanguage interactions) ----------

type InteractionResponse = {
  id?: string;
  status?: string;
  steps?: {
    type?: string;
    content?: {
      type?: string;
      mime_type?: string;
      mimeType?: string;
      data?: string;
    }[];
  }[];
  error?: { message?: string };
};

const toInputPart = (media: GeminiInputMedia, type: 'image' | 'video') => ({
  type,
  data: media.data,
  mime_type: media.mediaType,
});

export const generateVideoGemini = async (
  req: GenerateVideoGeminiRequest
): Promise<{ videos: GeneratedMedia[]; interactionId?: string }> => {
  const model = process.env.GEMINI_VIDEO_MODEL || 'gemini-omni-flash-preview';
  const url = `${GEMINI_API_HOST}/v1beta/interactions`;

  const images = req.images ?? [];
  const videos = req.videos ?? [];
  const input =
    images.length === 0 && videos.length === 0
      ? req.prompt
      : [
          ...videos.map((v) => toInputPart(v, 'video')),
          ...images.map((i) => toInputPart(i, 'image')),
          { type: 'text', text: req.prompt },
        ];

  // Edits (uploaded source video or stateful continuation) inherit the
  // source video's aspect ratio — the API rejects response_format.aspect_ratio
  // for edit tasks (400), so omit response_format entirely
  const isEdit = req.task === 'edit' || !!req.previousInteractionId;

  const token = await getGoogleAccessToken();
  const { status, body } = await postJson(
    url,
    {
      Authorization: `Bearer ${token}`,
      // Quota / billing attribution for the OAuth-style call
      'x-goog-user-project': getProjectId(),
    },
    {
      model,
      input,
      ...(isEdit
        ? {}
        : {
            response_format: {
              type: 'video',
              aspect_ratio: req.aspectRatio || '16:9',
            },
          }),
      // The API rejects previous_interaction_id combined with an explicit
      // video task (400) — stateful edits must rely on the interaction ID alone
      ...(req.task && !req.previousInteractionId
        ? { generation_config: { video_config: { task: req.task } } }
        : {}),
      ...(req.previousInteractionId
        ? { previous_interaction_id: req.previousInteractionId }
        : {}),
    }
  );

  if (status !== 200) {
    throwApiError('Gemini video API', status, body);
  }

  const res = JSON.parse(body) as InteractionResponse;
  if (res.error) {
    throw new Error(`Gemini video API error: ${res.error.message}`);
  }
  if (res.status && !['completed', 'succeeded'].includes(res.status)) {
    throw new Error(`Video generation did not complete (status=${res.status})`);
  }

  const generated: GeneratedMedia[] = [];
  for (const step of res.steps ?? []) {
    // Skip non-output steps (user_input / thought)
    if (step.type && step.type !== 'model_output') {
      continue;
    }
    for (const part of step.content ?? []) {
      if (part.type === 'video' && part.data) {
        generated.push({
          mimeType: part.mime_type ?? part.mimeType ?? 'video/mp4',
          data: part.data,
        });
      }
    }
  }
  if (generated.length === 0) {
    throw new Error('Gemini video API returned no video data');
  }
  return { videos: generated, interactionId: res.id };
};
