// Amazon Bedrock Web Search, the second search engine of the web
// search chat (the first one is Nova web grounding, see webGroundingApi.ts).
// https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html
//
// Web Search is a server-side tool of the Responses API on the bedrock-mantle
// endpoint. It is not reachable through the Converse API / bedrock-runtime
// client the rest of the chat uses, so this is a plain fetch signed with SigV4
// (service "bedrock-mantle") using the Lambda execution role's own
// credentials: no Bedrock API key and no OpenAI SDK dependency.
// Only OpenAI GPT-5.4+ models in us-east-1 / us-east-2 / us-west-2 support it,
// and not every model in every one of them: e.g. gpt-6.1-terra is us-east-1
// only on bedrock-mantle, and the gpt-6.1-sol model card lists no server-side
// tools. Check the model card before changing the model or the region.

import { createHash, createHmac } from 'node:crypto';

// Model ID as bedrock-mantle names it, e.g. openai.gpt-6.1-terra (no us./global.
// prefix). Empty means the GPT engine is not configured.
const MODEL_ID = process.env.WEB_GROUNDING_GPT_MODEL_ID ?? '';
const REGION = process.env.WEB_GROUNDING_GPT_REGION || 'us-east-1';

const SIGNING_SERVICE = 'bedrock-mantle';
const RESPONSES_URL = `https://bedrock-mantle.${REGION}.api.aws/openai/v1/responses`;

// One call covers the model's reasoning plus however many searches it decides
// to run, so it takes far longer than a single Converse lookup
const REQUEST_TIMEOUT_MS = 180_000;

export const isBedrockWebSearchEnabled = (): boolean => MODEL_ID !== '';

export const BEDROCK_WEB_SEARCH_MODEL_ID = MODEL_ID;

export type BedrockWebSearchCitation = {
  url: string;
  title?: string;
  // Offsets into BedrockWebSearchResult.text
  startIndex?: number;
  endIndex?: number;
};

export type BedrockWebSearchResult = {
  text: string;
  citations: BedrockWebSearchCitation[];
  // The searches the GPT model actually ran, for the trace
  queries: string[];
  // Reasoning tokens are included in outputTokens (Responses API semantics)
  usage: { inputTokens: number; outputTokens: number };
};

type ResponsesApiAnnotation = {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
};

type ResponsesApiOutputItem = {
  type: string;
  phase?: string;
  // type === 'web_search_call'
  action?: { query?: string; queries?: string[] };
  // type === 'message'
  content?: {
    type: string;
    text?: string;
    annotations?: ResponsesApiAnnotation[];
  }[];
};

type ResponsesApiResponse = {
  status?: string;
  output?: ResponsesApiOutputItem[];
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

// SigV4 headers for a JSON POST. Host is signed but not returned: fetch sets
// it from the URL itself.
const signRequest = (url: URL, body: string): Record<string, string> => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials are not available in the environment (expected Lambda execution role credentials)'
    );
  }

  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    'POST',
    url.pathname,
    '', // no query string
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SIGNING_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SIGNING_SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'host')
    ),
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

// Pull the answer text, its url_citation annotations and the searches that
// were run out of a Responses API result. Annotation offsets are relative to
// their own text block, so they are shifted as the blocks are concatenated.
const parseResponse = (
  response: ResponsesApiResponse
): BedrockWebSearchResult => {
  const output = response.output ?? [];

  const queries = output.flatMap((item) =>
    item.type === 'web_search_call'
      ? [
          ...(item.action?.query ? [item.action.query] : []),
          ...(item.action?.queries ?? []),
        ]
      : []
  );

  // GPT-5.x can emit commentary messages before the final answer
  const messages = output.filter((item) => item.type === 'message');
  const finalMessages = messages.filter(
    (item) => item.phase === 'final_answer'
  );

  let text = '';
  const citations: BedrockWebSearchCitation[] = [];
  for (const message of finalMessages.length > 0 ? finalMessages : messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'output_text' || !block.text) {
        continue;
      }
      if (text) {
        text += '\n\n';
      }
      const offset = text.length;
      text += block.text;
      for (const annotation of block.annotations ?? []) {
        if (annotation.type !== 'url_citation' || !annotation.url) {
          continue;
        }
        citations.push({
          url: annotation.url,
          title: annotation.title,
          startIndex:
            annotation.start_index !== undefined
              ? offset + annotation.start_index
              : undefined,
          endIndex:
            annotation.end_index !== undefined
              ? offset + annotation.end_index
              : undefined,
        });
      }
    }
  }

  return {
    text,
    citations,
    queries: [...new Set(queries)],
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
};

// Run one lookup with the web_search tool of the configured GPT model
export const invokeBedrockWebSearch = async (
  query: string,
  instructions: string
): Promise<BedrockWebSearchResult> => {
  if (!isBedrockWebSearchEnabled()) {
    throw new Error(
      'Bedrock Web Search is not configured. Set webGroundingGptModelId in cdk.json and redeploy.'
    );
  }

  const body = JSON.stringify({
    model: MODEL_ID,
    instructions,
    input: query,
    tools: [
      {
        type: 'web_search',
        // Keep retrieval inside the AWS boundary (Bedrock web index + cache).
        // It must be sent explicitly: the default is true, which needs the
        // bedrock-websearch:ExternalWebAccess permission the Lambda lacks.
        external_web_access: false,
      },
    ],
    // A lookup, not an analysis: the conversation model does the thinking
    reasoning: { effort: 'low' },
    // Nothing to continue later, so do not keep the response on the server
    store: false,
  });

  const url = new URL(RESPONSES_URL);
  const res = await fetch(url, {
    method: 'POST',
    headers: signRequest(url, body),
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await res.text();
  let response: ResponsesApiResponse | undefined;
  try {
    response = JSON.parse(raw) as ResponsesApiResponse;
  } catch {
    response = undefined;
  }

  if (!res.ok || !response) {
    throw new Error(
      `Bedrock Web Search failed (${res.status}): ${
        response?.error?.message ?? raw.slice(0, 500)
      }`
    );
  }
  if (response.status === 'failed') {
    throw new Error(
      `Bedrock Web Search failed: ${response.error?.message ?? 'Unknown error'}`
    );
  }
  if (response.status === 'incomplete') {
    // Still usable: whatever text came back is returned below
    console.warn(
      'Bedrock Web Search response is incomplete',
      response.incomplete_details
    );
  }

  return parseResponse(response);
};
