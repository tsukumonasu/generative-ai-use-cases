// Fork custom: Gemini (Google Gemini API) image / video generation.
// Invokes the Lambda directly (IAM auth via Identity Pool) instead of going
// through API Gateway, to avoid the 29s integration timeout.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { fetchAuthSession } from 'aws-amplify/auth';
import {
  GeminiMode,
  GeminiInvokeEvent,
  GenerateImageGeminiRequest,
  GenerateVideoGeminiRequest,
  GenerateGeminiResponse,
} from 'generative-ai-use-cases';

// Lambda request payload limit is 6MB (6,291,456 bytes)
const LAMBDA_PAYLOAD_LIMIT = 6_291_456;

const invoke = async (
  mode: GeminiMode,
  request: GenerateImageGeminiRequest | GenerateVideoGeminiRequest,
  // Chat ID of an ongoing interactive session (appends to that chat)
  chatId?: string
): Promise<GenerateGeminiResponse> => {
  const token = (await fetchAuthSession()).tokens?.idToken?.toString();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const region = import.meta.env.VITE_APP_REGION;
  const userPoolId = import.meta.env.VITE_APP_USER_POOL_ID;
  const idPoolId = import.meta.env.VITE_APP_IDENTITY_POOL_ID;
  const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const lambda = new LambdaClient({
    region,
    requestHandler: {
      requestTimeout: 900000,
      socketTimeout: 900000,
      connectionTimeout: 10000,
    },
    credentials: fromCognitoIdentityPool({
      clientConfig: { region },
      identityPoolId: idPoolId,
      logins: {
        [providerName]: token,
      },
    }),
  });

  const event: GeminiInvokeEvent = { mode, idToken: token, request, chatId };
  const payload = JSON.stringify(event);

  const payloadSize = new Blob([payload]).size;
  if (payloadSize > LAMBDA_PAYLOAD_LIMIT) {
    const error = new Error(
      `Payload size ${payloadSize} bytes exceeds Lambda limit of ${LAMBDA_PAYLOAD_LIMIT} bytes`
    );
    error.name = 'PayloadTooLargeError';
    throw error;
  }

  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: import.meta.env.VITE_APP_GEMINI_FUNCTION_ARN,
      Payload: payload,
    })
  );

  const body = JSON.parse(new TextDecoder('utf-8').decode(res.Payload));

  if (res.FunctionError) {
    throw new Error(body?.errorMessage ?? res.FunctionError);
  }

  return body as GenerateGeminiResponse;
};

const useGeminiApi = () => {
  return {
    generateImage: (params: GenerateImageGeminiRequest, chatId?: string) => {
      return invoke('image', params, chatId);
    },
    generateVideo: (params: GenerateVideoGeminiRequest, chatId?: string) => {
      return invoke('video', params, chatId);
    },
  };
};

export default useGeminiApi;
