// Fork custom: LLM-planned multi-image generation from a referenced chat.
// A text model reads the conversation transcript and the user's request,
// decides how many images best cover it (up to MAX_PLANNED_IMAGES), and
// returns one self-contained image-generation prompt per image.
import {
  Model,
  PredictRequest,
  StreamingChunk,
  UnrecordedMessage,
} from 'generative-ai-use-cases';

export const MAX_PLANNED_IMAGES = 20;

// Matches useChatApi().predictStream (called with decode = false so chunk
// boundaries never split multi-byte characters)
type PredictStreamFn = (
  req: PredictRequest,
  decode?: boolean
) => AsyncGenerator<string | Uint8Array | undefined, void, unknown>;

// ImageChatContext.transcript is framed for the image model (leading
// "Generate exactly one image..." order and a trailing instruction line).
// For the planner LLM, keep only the conversation itself.
const extractConversation = (framedTranscript: string): string => {
  const open = '<conversation>';
  const start = framedTranscript.indexOf(open);
  const end = framedTranscript.lastIndexOf('</conversation>');
  if (start >= 0 && end > start) {
    return framedTranscript.slice(start + open.length, end).trim();
  }
  return framedTranscript;
};

const buildPlanMessages = (
  rawTranscript: string,
  instruction: string
): UnrecordedMessage[] => [
  {
    role: 'system',
    content: [
      'You are a planner that turns a conversation log into a set of image-generation prompts, like slides of a presentation deck.',
      'Respond with a single JSON object only — no explanations, no code fences.',
    ].join('\n'),
  },
  {
    role: 'user',
    content: [
      'Here is a conversation between a user and an AI assistant:',
      '<conversation>',
      rawTranscript,
      '</conversation>',
      '',
      "The user's request for the images to generate from this conversation:",
      '<request>',
      instruction,
      '</request>',
      '',
      'Rules:',
      `- Decide the most appropriate number of images, between 1 and ${MAX_PLANNED_IMAGES}, to fulfill the request. Use multiple images when the conversation covers multiple distinct topics, steps, or conclusions; use fewer for simple content. Never exceed ${MAX_PLANNED_IMAGES}.`,
      '- Each element must be a complete, self-contained image-generation prompt describing ONE image: its subject, layout, and any text to render in the image.',
      '- Include the concrete facts, numbers, and names from the conversation that the image should show — the image model relies on your prompt.',
      '- Write each prompt in the same language as the conversation.',
      '- Output format: {"imagePrompts": ["prompt for image 1", "prompt for image 2", ...]}',
    ].join('\n'),
  },
];

const parseImagePlan = (text: string): string[] => {
  // Tolerate code fences and prose around the JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`No JSON object in plan response: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    imagePrompts?: unknown;
  };
  const prompts = (
    Array.isArray(parsed.imagePrompts) ? parsed.imagePrompts : []
  ).filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (prompts.length === 0) {
    throw new Error('Plan response contained no image prompts');
  }
  return prompts.slice(0, MAX_PLANNED_IMAGES);
};

// Ask the selected text model to plan the image set. Uses predictStream
// (direct Lambda invoke) instead of the buffered predict API to avoid the
// 29s API Gateway timeout on long plans. Accepts the framed transcript
// (ImageChatContext.transcript) as-is.
export const planImagePrompts = async (
  predictStream: PredictStreamFn,
  model: Model,
  framedTranscript: string,
  instruction: string
): Promise<string[]> => {
  // Buffer the whole stream, then parse the newline-delimited JSON chunks
  let buffer = new Uint8Array(0);
  for await (const chunk of predictStream(
    {
      model,
      messages: buildPlanMessages(
        extractConversation(framedTranscript),
        instruction
      ),
      id: '/image-plan',
    },
    false
  )) {
    if (!chunk || typeof chunk === 'string') continue;
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
  }

  let text = '';
  for (const line of new TextDecoder('utf-8').decode(buffer).split('\n')) {
    if (!line.trim()) continue;
    let payload: StreamingChunk;
    try {
      payload = JSON.parse(line) as StreamingChunk;
    } catch {
      // Skip malformed fragments (defensive — lines are complete after buffering)
      continue;
    }
    if (payload.errorCode) {
      throw new Error(`Image planning failed (${payload.errorCode})`);
    }
    text += payload.text ?? '';
  }

  return parseImagePlan(text);
};
