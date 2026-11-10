import { Handler, Context } from 'aws-lambda';
import { PredictRequest } from 'generative-ai-use-cases';
import bedrockApi from './utils/bedrockApi';
import { defaultModel } from './utils/models';
import {
  invokeWebGroundingStream,
  isWebGroundingSupported,
} from './utils/webGroundingApi';

declare global {
  namespace awslambda {
    function streamifyResponse(
      f: (
        event: PredictRequest,
        responseStream: NodeJS.WritableStream,
        context: Context
      ) => Promise<void>
    ): Handler;
  }
}

// Streaming chat that can call web search (Amazon Nova web grounding, or
// Amazon Bedrock Web Search on GPT, per event.webSearchEngine) as a tool.
// Invoked directly from the frontend (like predictStream) because API Gateway
// caps synchronous integrations at 29 seconds.
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    const model = event.model || defaultModel;

    const stream = isWebGroundingSupported(model)
      ? invokeWebGroundingStream(
          model,
          event.messages,
          event.id,
          event.webSearchEngine
        )
      : // Not a Bedrock text model: answer without web search rather than fail
        (bedrockApi.invokeStream?.(
          model,
          event.messages,
          event.id,
          event.idToken
        ) ?? []);

    for await (const token of stream) {
      responseStream.write(token);
    }
    responseStream.end();
  }
);
