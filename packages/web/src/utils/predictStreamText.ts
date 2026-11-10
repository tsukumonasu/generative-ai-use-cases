// Run a one-shot text-model call over predictStream (direct
// Lambda invoke) and collect the whole response as a string.
// Used by the planners that need a full answer before continuing, and that
// would otherwise hit the 29s API Gateway timeout of the buffered predict API.
import {
  PredictRequest,
  StreamingChunk,
  UnrecordedMessage,
  Model,
} from 'generative-ai-use-cases';

// Matches useChatApi().predictStream (called with decode = false so chunk
// boundaries never split multi-byte characters)
export type PredictStreamFn = (
  req: PredictRequest,
  decode?: boolean
) => AsyncGenerator<string | Uint8Array | undefined, void, unknown>;

export const collectPredictStreamText = async (
  predictStream: PredictStreamFn,
  model: Model,
  messages: UnrecordedMessage[],
  // Usecase id recorded with the call
  id: string
): Promise<string> => {
  // Buffer the whole stream, then parse the newline-delimited JSON chunks
  let buffer = new Uint8Array(0);
  for await (const chunk of predictStream({ model, messages, id }, false)) {
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
      throw new Error(`${id} failed (${payload.errorCode})`);
    }
    text += payload.text ?? '';
  }

  return text;
};

// Extract the outermost JSON object from a model response, tolerating code
// fences and prose around it
export const parseJsonObject = <T>(text: string): T => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`No JSON object in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
};
