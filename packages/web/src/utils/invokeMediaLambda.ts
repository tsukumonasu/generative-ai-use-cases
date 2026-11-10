// Direct invoke of the media Lambdas (GPT Image, Gemini image /
// video). They are invoked directly (IAM auth via the Identity Pool) instead
// of going through API Gateway, to avoid the 29s integration timeout. The
// handler receives no Cognito claims, so the ID token travels in the payload
// and is verified there.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { fetchAuthSession } from 'aws-amplify/auth';

// Lambda request payload limit is 6MB (6,291,456 bytes)
const LAMBDA_PAYLOAD_LIMIT = 6_291_456;

// `event` is the invoke event without its `idToken`, which is added here
export const invokeMediaLambda = async <
  TEvent extends { idToken?: string },
  TResponse,
>(
  functionArn: string,
  event: Omit<TEvent, 'idToken'>
): Promise<TResponse> => {
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

  const payload = JSON.stringify({ ...event, idToken: token });

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
      FunctionName: functionArn,
      Payload: payload,
    })
  );

  const body = JSON.parse(new TextDecoder('utf-8').decode(res.Payload));

  if (res.FunctionError) {
    throw new Error(body?.errorMessage ?? res.FunctionError);
  }

  return body as TResponse;
};
