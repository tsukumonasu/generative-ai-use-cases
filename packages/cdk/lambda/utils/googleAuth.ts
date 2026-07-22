// Fork custom: Google Cloud access token via Workload Identity Federation.
// No API key and no google-auth-library dependency (plain fetch + node:crypto,
// matching the gptImageApi style). The Lambda execution role's AWS credentials
// are exchanged for a Google access token:
//   1. SigV4-sign an AWS STS GetCallerIdentity request (the "subject token")
//   2. Exchange it at Google STS (sts.googleapis.com/v1/token)
//   3. Impersonate the target service account (iamcredentials generateAccessToken)
// Google-side setup (workload identity pool / provider / service account) is
// documented in docs/ja/GEMINI.md.

import { createHash, createHmac } from 'node:crypto';

// Scopes for the final (impersonated) token, matching the official Gemini API
// OAuth setup (https://ai.google.dev/gemini-api/docs/oauth):
// - cloud-platform: aiplatform generateContent (image), STS/iamcredentials
// - generative-language.retriever: required by generativelanguage
//   (interactions/video) — cloud-platform alone gets rejected with
//   403 ACCESS_TOKEN_SCOPE_INSUFFICIENT. Note the bare "generative-language"
//   scope does not exist (400 invalid_scope); ".retriever" is the valid one.
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SCOPES = [
  CLOUD_PLATFORM_SCOPE,
  'https://www.googleapis.com/auth/generative-language.retriever',
];
const GOOGLE_STS_URL = 'https://sts.googleapis.com/v1/token';

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
};

const getAwsCredentials = (): AwsCredentials => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error(
      'AWS credentials are not available in the environment (expected Lambda execution role credentials)'
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region,
  };
};

// Build the SigV4-signed GetCallerIdentity request and serialize it in the
// format Google STS expects as an AWS subject token
// (URL-encoded JSON of { url, method, headers }).
const buildSubjectToken = (audience: string, creds: AwsCredentials): string => {
  const host = `sts.${creds.region}.amazonaws.com`;
  const query = 'Action=GetCallerIdentity&Version=2011-06-15';
  const url = `https://${host}/?${query}`;

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);

  // Headers included in the signature (sorted by lowercase name)
  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-goog-cloud-target-resource': audience,
  };
  if (creds.sessionToken) {
    headers['x-amz-security-token'] = creds.sessionToken;
  }
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    'POST',
    '/',
    query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(''), // empty body
  ].join('\n');

  const credentialScope = `${dateStamp}/${creds.region}/sts/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, 'sts');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const subjectToken = {
    url,
    method: 'POST',
    headers: [
      ...sortedNames.map((name) => ({ key: name, value: headers[name] })),
      { key: 'Authorization', value: authorization },
    ],
  };

  return encodeURIComponent(JSON.stringify(subjectToken));
};

// Exchange the AWS subject token for a Google federated access token
const exchangeToken = async (audience: string): Promise<string> => {
  const subjectToken = buildSubjectToken(audience, getAwsCredentials());

  const res = await fetch(GOOGLE_STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      // The federated token is only used to call iamcredentials
      // generateAccessToken, so cloud-platform alone is sufficient here
      scope: CLOUD_PLATFORM_SCOPE,
      subjectTokenType: 'urn:ietf:params:aws:token-type:aws4_request',
      subjectToken,
    }),
  });

  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google STS token exchange failed (${res.status}): ${
        body.error_description ?? body.error ?? 'Unknown error'
      }`
    );
  }
  return body.access_token;
};

// Impersonate the service account with the federated token
const impersonate = async (
  federatedToken: string,
  serviceAccountEmail: string
): Promise<{ token: string; expiry: number }> => {
  const res = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${federatedToken}`,
      },
      body: JSON.stringify({ scope: SCOPES, lifetime: '3600s' }),
    }
  );

  const body = (await res.json()) as {
    accessToken?: string;
    expireTime?: string;
    error?: { message?: string };
  };
  if (!res.ok || !body.accessToken) {
    throw new Error(
      `Service account impersonation failed (${res.status}): ${
        body.error?.message ?? 'Unknown error'
      }. Check that the workload identity principal has roles/iam.workloadIdentityUser on ${serviceAccountEmail}.`
    );
  }
  return {
    token: body.accessToken,
    expiry: body.expireTime
      ? Date.parse(body.expireTime)
      : Date.now() + 3600_000,
  };
};

// Cache across warm invocations; refresh 5 minutes before expiry
let cached: { token: string; expiry: number } | undefined;

export const getGoogleAccessToken = async (): Promise<string> => {
  if (cached && cached.expiry - Date.now() > 5 * 60_000) {
    return cached.token;
  }

  const audience = process.env.GOOGLE_WIF_AUDIENCE;
  const serviceAccountEmail = process.env.GOOGLE_SA_EMAIL;
  if (!audience || !serviceAccountEmail) {
    throw new Error(
      'GOOGLE_WIF_AUDIENCE / GOOGLE_SA_EMAIL are not configured. Set geminiWifAudience / geminiServiceAccountEmail in cdk.json (see docs/ja/GEMINI.md) and redeploy.'
    );
  }

  const federatedToken = await exchangeToken(audience);
  cached = await impersonate(federatedToken, serviceAccountEmail);
  return cached.token;
};
