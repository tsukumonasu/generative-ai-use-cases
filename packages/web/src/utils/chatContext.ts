// Fork custom: build an image-generation context from an existing chat.
// The transcript is sent as GenerateImage(Gpt|Gemini)Request.chatContext and
// prepended to the prompt server-side for the model call only.
import { RecordedMessage } from 'generative-ai-use-cases';

// A chat referenced as context for image generation
export type ImageChatContext = {
  chatId: string;
  title: string;
  messageCount: number;
  transcript: string;
};

// Keep the composed prompt (transcript + framing + user prompt) well within
// image model limits — gpt-image-1 rejects prompts over 32,000 characters,
// and very long prompts degrade generation quality on both models
const MAX_TRANSCRIPT_LENGTH = 10000;

export const buildChatTranscript = (messages: RecordedMessage[]): string => {
  const lines = messages
    .filter((m) => m.role !== 'system' && m.content)
    .map((m) => `${m.role}: ${m.content}`);

  // When the conversation exceeds the cap, keep the most recent messages —
  // the conclusion lives at the end
  let transcript = '';
  let omitted = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (transcript.length + lines[i].length + 1 > MAX_TRANSCRIPT_LENGTH) {
      omitted = true;
      break;
    }
    transcript = transcript ? `${lines[i]}\n${transcript}` : lines[i];
  }
  // A single message longer than the cap: keep its tail
  if (!transcript && lines.length > 0) {
    transcript = lines[lines.length - 1].slice(-MAX_TRANSCRIPT_LENGTH);
    omitted = true;
  }

  // Without an explicit "generate an image" order the models often answer
  // the conversation in text instead of drawing — make it unmistakable,
  // and place the user's instruction right after the trailing line
  // (the server appends the prompt after this block)
  return [
    'Generate exactly one image. The output must be an image — never answer in text.',
    'Use the following conversation between a user and an AI assistant as the source material.',
    '<conversation>',
    ...(omitted ? ['(earlier messages omitted)'] : []),
    transcript,
    '</conversation>',
    'Instruction for the single image to generate from the conversation above:',
  ].join('\n');
};
