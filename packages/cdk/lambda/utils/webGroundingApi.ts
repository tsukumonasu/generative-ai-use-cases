import {
  AccessDeniedException,
  ContentBlock,
  ConversationRole,
  ConverseCommand,
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  Message,
  ServiceQuotaExceededException,
  StopReason,
  ThrottlingException,
  Tool,
  ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  Metadata,
  Model,
  UnrecordedMessage,
  WebSearchEngine,
  WebSearchUsage,
} from 'generative-ai-use-cases';
import { BEDROCK_TEXT_GEN_MODELS } from './models';
import { streamingChunk } from './streamingChunk';
import { classifyStreamingError } from './streamingError';
import { initBedrockRuntimeClient } from './bedrockClient';
import {
  BEDROCK_WEB_SEARCH_MODEL_ID,
  invokeBedrockWebSearch,
  isBedrockWebSearchEnabled,
} from './bedrockWebSearchApi';

const MODEL_REGION = process.env.MODEL_REGION as string;

// The web_search tool below can be served by either of two engines, chosen by
// the user on the page:
// - 'gpt': Amazon Bedrock Web Search on a GPT model, only when
//   webGroundingGptModelId is configured (see bedrockWebSearchApi.ts).
//   The default whenever it is available.
// - 'nova': Amazon Nova web grounding (always available)
const ENGINE_LABELS: Record<WebSearchEngine, string> = {
  nova: 'Amazon Nova',
  gpt: 'Bedrock Web Search (GPT)',
};

// Amazon Nova web grounding.
// Only Nova 2 models in US regions / US CRIS profiles can use it.
// https://docs.aws.amazon.com/nova/latest/nova2-userguide/web-grounding.html
const WEB_GROUNDING_MODEL_ID =
  process.env.WEB_GROUNDING_MODEL_ID || 'us.amazon.nova-2-lite-v1:0';
const WEB_GROUNDING_REGION = process.env.WEB_GROUNDING_REGION || 'us-east-1';

// The search itself is a Bedrock *system* tool: only its name is passed, and a
// toolSpec with the same name must never be declared (Bedrock rejects that).
const NOVA_GROUNDING_TOOL = 'nova_grounding';

// The tool the conversation model calls to reach the search above
const WEB_SEARCH_TOOL = 'web_search';

// How many turns may actually run a search. One turn can contain several
// searches, so this is a bound on round trips, not on queries.
const MAX_SEARCH_ROUNDS = 5;

const MAX_GROUNDING_TOKENS = 4096;

// Neither model knows what day it is, so both are told. Without this they fall
// back on their training data and search for a year that is already past.
const today = (): string => new Date().toISOString().slice(0, 10);

const buildWebSearchTool = (): Tool => ({
  toolSpec: {
    name: WEB_SEARCH_TOOL,
    description: `Look up one simple fact on the web and get back excerpts of what the sources say, together with their URLs.
Call this whenever the answer depends on information you cannot be certain about from memory: current events, prices, schedules, product or library releases, statistics, regulations, or anything else that changes over time.
Do not call it for small talk, translation, reformatting, or questions about material the user already provided.
This tool is a plain lookup, not a researcher: it cannot compare, judge, decide, or reason. Asking it anything complex makes it invent plausible answers.
So keep every query to a single subject and a single point, and do all the comparing, combining and concluding yourself.
Break a complex question into several simple queries and call the tool once per query, either in the same turn or in a later turn to follow up.`,
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: `What to look up, as short self-contained keywords about ONE subject, the way you would type it into a search box.
Ask for a plain fact ("<company name> business overview", "<library> latest version"), never for an analysis, a comparison, a relationship between two subjects, or a judgement ("difference between A and B", "which is better", "is A a subsidiary of B").
To compare two subjects, look each one up in its own query and compare the results yourself.
Today is ${today()} (UTC). Do not put a past year in the query: leave the year out, or use the current one when you specifically want this year's edition of something.
Write it in the language that best matches the sources you want, which is usually the language the user is writing in.`,
          },
        },
        required: ['query'],
      },
    },
  },
});

const groundingSystemPrompt = (): string =>
  `You are a lookup tool that extracts text from web pages. You are not an assistant and you do not answer questions.
Search the web for the given query and report only statements that a retrieved page literally makes, staying as close to its wording as possible.
Include the concrete facts it gives: numbers, dates, names, addresses and version numbers.
Never merge two pages into one statement, never infer or explain a relationship between two things unless a page states that relationship itself, and never add anything you happen to know.
If a page is about something that merely has a similar name to the query, say so rather than treating it as the same thing.
Today is ${today()} (UTC). Prefer the most recently updated pages, skip material that is clearly about an earlier year unless the query asked for that year, and state the year or "as of" date whenever a page gives one.
If nothing relevant was found, say exactly that instead of guessing.
Report in the same language as the query.`;

type WebSource = {
  url: string;
  domain?: string;
  title?: string;
};

// A piece of the answer together with the sources backing it. An excerpt with
// no source is the grounding model's own wording, which is where it makes
// things up, so the two are kept apart all the way to the calling model.
type WebExcerpt = {
  text: string;
  sourceIndices: number[];
};

// What one search cost, shown under the answer next to the conversation
// model's own tokens
type SearchUsage = Omit<WebSearchUsage, 'calls'>;

type WebSearchResult = {
  excerpts: WebExcerpt[];
  sources: WebSource[];
  // Searches the engine decided to run by itself (GPT only), for the trace
  engineQueries?: string[];
  usage: SearchUsage;
};

// Collects excerpts together with their de-duplicated sources
const createResultBuilder = () => {
  const excerpts: WebExcerpt[] = [];
  const sources: WebSource[] = [];

  const sourceIndex = (source: WebSource): number => {
    const existing = sources.findIndex((s) => s.url === source.url);
    if (existing >= 0) {
      return existing;
    }
    return sources.push(source) - 1;
  };

  const pushExcerpt = (text: string, sourceIndices: number[]) => {
    if (!text.trim()) {
      return;
    }
    // Consecutive blocks with the same backing sources are one excerpt
    const last = excerpts[excerpts.length - 1];
    if (last && String(last.sourceIndices) === String(sourceIndices)) {
      last.text += text;
    } else {
      excerpts.push({ text, sourceIndices });
    }
  };

  const build = (): Pick<WebSearchResult, 'excerpts' | 'sources'> => {
    for (const excerpt of excerpts) {
      excerpt.text = excerpt.text.trim();
    }
    return { excerpts, sources };
  };

  return { sourceIndex, pushExcerpt, build };
};

// Run one web search with Nova web grounding.
// The response interleaves plain text blocks with citation blocks that carry
// both the cited passage and the web location it came from.
const searchWebWithNova = async (query: string): Promise<WebSearchResult> => {
  const client = await initBedrockRuntimeClient({
    region: WEB_GROUNDING_REGION,
  });

  const output = await client.send(
    new ConverseCommand({
      modelId: WEB_GROUNDING_MODEL_ID,
      system: [{ text: groundingSystemPrompt() }],
      messages: [{ role: ConversationRole.USER, content: [{ text: query }] }],
      toolConfig: { tools: [{ systemTool: { name: NOVA_GROUNDING_TOOL } }] },
      inferenceConfig: { maxTokens: MAX_GROUNDING_TOKENS },
    })
  );

  const { sourceIndex, pushExcerpt, build } = createResultBuilder();

  for (const block of output.output?.message?.content ?? []) {
    if (block.text) {
      pushExcerpt(block.text, []);
    } else if (block.citationsContent) {
      const text = (block.citationsContent.content ?? [])
        .map((content) => content.text ?? '')
        .join('');

      const indices = (block.citationsContent.citations ?? []).flatMap(
        (citation) => {
          const web = citation.location?.web;
          return web?.url
            ? [
                sourceIndex({
                  url: web.url,
                  domain: web.domain,
                  title: citation.title,
                }),
              ]
            : [];
        }
      );

      pushExcerpt(
        text,
        [...new Set(indices)].sort((a, b) => a - b)
      );
    }
  }

  return {
    ...build(),
    usage: {
      modelId: WEB_GROUNDING_MODEL_ID,
      inputTokens: output.usage?.inputTokens ?? 0,
      outputTokens: output.usage?.outputTokens ?? 0,
    },
  };
};

const domainOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

// Run one web search with Amazon Bedrock Web Search on a GPT model.
// GPT writes its citations inline as markdown links, and its url_citation
// annotations point at those links rather than at the claim they back. So a
// paragraph counts as backed by the sources it links to, and a paragraph that
// links nothing is the model's own unsourced prose, just like Nova's plain text
// blocks. The annotation offset is only a fallback for a link not written out.
const searchWebWithGpt = async (query: string): Promise<WebSearchResult> => {
  const { text, citations, queries, usage } = await invokeBedrockWebSearch(
    query,
    groundingSystemPrompt()
  );
  const { sourceIndex, pushExcerpt, build } = createResultBuilder();

  const paragraphs: {
    text: string;
    start: number;
    end: number;
    sourceIndices: Set<number>;
  }[] = [];
  let start = 0;
  for (const separator of text.matchAll(/\n\s*\n/g)) {
    const end = separator.index ?? start;
    paragraphs.push({
      text: text.slice(start, end),
      start,
      end,
      sourceIndices: new Set(),
    });
    start = end + separator[0].length;
  }
  paragraphs.push({
    text: text.slice(start),
    start,
    end: text.length,
    sourceIndices: new Set(),
  });

  for (const citation of citations) {
    const index = sourceIndex({
      url: citation.url,
      domain: domainOf(citation.url),
      title: citation.title,
    });
    const linking = paragraphs.filter((p) => p.text.includes(citation.url));
    const backed =
      linking.length > 0
        ? linking
        : paragraphs.filter(
            (p) =>
              citation.startIndex !== undefined &&
              citation.startIndex >= p.start &&
              citation.startIndex < p.end
          );
    for (const paragraph of backed) {
      paragraph.sourceIndices.add(index);
    }
  }

  for (const paragraph of paragraphs) {
    // The blank line keeps merged paragraphs apart; build() trims the ends
    pushExcerpt(
      `${paragraph.text}\n\n`,
      [...paragraph.sourceIndices].sort((a, b) => a - b)
    );
  }

  return {
    ...build(),
    engineQueries: queries,
    usage: { modelId: BEDROCK_WEB_SEARCH_MODEL_ID, ...usage },
  };
};

const searchWeb = (
  query: string,
  engine: WebSearchEngine
): Promise<WebSearchResult> =>
  engine === 'gpt' ? searchWebWithGpt(query) : searchWebWithNova(query);

const formatSources = (sources: WebSource[]): string =>
  sources
    .map(
      (source, i) =>
        `${i + 1}. [${source.title || source.domain || source.url}](${source.url})`
    )
    .join('\n');

// AWS requires citations to be kept in what is shown to the end user, so the
// instruction is repeated here instead of relying on the (user editable)
// system prompt alone.
const formatToolResult = (result: WebSearchResult): string => {
  const excerpts = result.excerpts
    .map((excerpt) =>
      excerpt.sourceIndices.length > 0
        ? `<excerpt sources="${excerpt.sourceIndices.map((i) => i + 1).join(',')}">\n${excerpt.text}\n</excerpt>`
        : `<unsourced>\n${excerpt.text}\n</unsourced>`
    )
    .join('\n');

  const sources =
    result.sources.length > 0
      ? `\n\n<sources>\n${formatSources(result.sources)}\n</sources>`
      : '';

  return `<search_result>
${excerpts || 'Nothing relevant was found.'}
</search_result>${sources}

This is raw material from a search tool, not an answer, and the tool is known to blur things that have similar names.
Trust an <excerpt> only as a statement of the sources listed in its sources attribute; treat <unsourced> text as an unverified hint.
Do not conclude that two things are related, identical, or that one owns the other unless a single excerpt says so directly.
If this does not cover what you needed, search again with a simpler query instead of filling the gap from memory.
Cite every source you actually use as a markdown link.`;
};

const formatSearchTrace = (result: WebSearchResult): string => {
  const engineQueries =
    result.engineQueries && result.engineQueries.length > 0
      ? `\n\n↳ ${result.engineQueries.map((q) => `\`${q}\``).join(' / ')}`
      : '';
  const text = result.excerpts.map((excerpt) => excerpt.text).join('\n');
  const sources =
    result.sources.length > 0 ? `\n\n${formatSources(result.sources)}` : '';
  return `${engineQueries}\n\n${text}${sources}\n\n`;
};

// The search engine's tokens travel as a metadata chunk of their own, one per
// search, which the frontend adds to the answer's metadata the same way it
// adds up the conversation model's rounds. usage stays zero: it belongs to the
// conversation model (llmType) and feeds the token stats.
const searchUsageChunk = (usage: SearchUsage): string =>
  streamingChunk({
    text: '',
    metadata: {
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      webSearchUsage: [{ ...usage, calls: 1 }],
    },
  });

const parseToolInput = (input: string): Record<string, unknown> => {
  try {
    return input ? JSON.parse(input) : {};
  } catch (e) {
    console.warn(`Failed to parse tool input: ${input}`, e);
    return {};
  }
};

type PendingContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'reasoning';
      text: string;
      signature: string;
      redactedContent?: Uint8Array;
    }
  | { type: 'toolUse'; toolUseId: string; name: string; input: string };

// Rebuild the assistant turn so it can be replayed together with the tool
// results. Reasoning blocks have to be preserved as-is (signature included) or
// models with extended / adaptive thinking reject the follow-up request.
const toContentBlocks = (
  blocks: Map<number, PendingContentBlock>
): ContentBlock[] =>
  [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, block]): ContentBlock[] => {
      if (block.type === 'text') {
        // Bedrock rejects a text block that is empty or only whitespace
        // (#1801). Dropping it is safe here: this turn is replayed
        // only when it ended in tool_use, so it always keeps its toolUse.
        return block.text.trim() !== '' ? [{ text: block.text }] : [];
      }
      if (block.type === 'reasoning') {
        return [
          block.redactedContent
            ? { reasoningContent: { redactedContent: block.redactedContent } }
            : {
                reasoningContent: {
                  reasoningText: {
                    text: block.text,
                    signature: block.signature,
                  },
                },
              },
        ];
      }
      return [
        {
          toolUse: {
            toolUseId: block.toolUseId,
            name: block.name,
            input: parseToolInput(block.input) as ToolUseBlock['input'],
          },
        },
      ];
    });

// Chat with the user's model of choice, letting it call web search (Nova web
// grounding or Bedrock Web Search on GPT) as a tool and analyze the results
// itself.
export const invokeWebGroundingStream = async function* (
  model: Model,
  messages: UnrecordedMessage[],
  id: string,
  engine?: WebSearchEngine
): AsyncGenerator<string> {
  const region = model.region || MODEL_REGION;
  const client = await initBedrockRuntimeClient({ region });
  const modelConfig = BEDROCK_TEXT_GEN_MODELS[model.modelId];
  // GPT is preferred whenever it is configured; Nova only when the user picked
  // it explicitly. GPT asked for but not configured (e.g. a tab opened before
  // it was turned off) falls back to Nova rather than failing every search.
  const searchEngine: WebSearchEngine =
    isBedrockWebSearchEnabled() && engine !== 'nova' ? 'gpt' : 'nova';

  try {
    const baseInput: ConverseStreamCommandInput = {
      ...modelConfig.createConverseStreamCommandInput(
        messages,
        id,
        model,
        modelConfig.defaultParams,
        modelConfig.usecaseParams
      ),
      toolConfig: { tools: [buildWebSearchTool()] },
    };
    const conversation: Message[] = [...(baseInput.messages ?? [])];

    for (let round = 0; round <= MAX_SEARCH_ROUNDS + 1; round++) {
      const responseStream = await client.send(
        new ConverseStreamCommand({ ...baseInput, messages: conversation })
      );

      if (!responseStream.stream) {
        return;
      }

      const blocks = new Map<number, PendingContentBlock>();
      let stopReason: StopReason | undefined;

      for await (const response of responseStream.stream) {
        if (!response) {
          break;
        }

        if (response.contentBlockStart?.start?.toolUse) {
          const toolUse = response.contentBlockStart.start.toolUse;
          blocks.set(response.contentBlockStart.contentBlockIndex ?? 0, {
            type: 'toolUse',
            toolUseId: toolUse.toolUseId ?? '',
            name: toolUse.name ?? '',
            input: '',
          });
        } else if (response.contentBlockDelta?.delta) {
          const index = response.contentBlockDelta.contentBlockIndex ?? 0;
          const delta = response.contentBlockDelta.delta;

          if (delta.text) {
            let block = blocks.get(index);
            if (block?.type !== 'text') {
              block = { type: 'text', text: '' };
              blocks.set(index, block);
            }
            block.text += delta.text;
            yield streamingChunk({ text: delta.text });
          } else if (delta.reasoningContent) {
            let block = blocks.get(index);
            if (block?.type !== 'reasoning') {
              block = { type: 'reasoning', text: '', signature: '' };
              blocks.set(index, block);
            }
            if (delta.reasoningContent.text) {
              block.text += delta.reasoningContent.text;
              yield streamingChunk({
                text: '',
                trace: delta.reasoningContent.text,
              });
            }
            if (delta.reasoningContent.signature) {
              block.signature += delta.reasoningContent.signature;
            }
            if (delta.reasoningContent.redactedContent) {
              block.redactedContent = delta.reasoningContent.redactedContent;
            }
          } else if (delta.toolUse?.input !== undefined) {
            const block = blocks.get(index);
            if (block?.type === 'toolUse') {
              block.input += delta.toolUse.input;
            }
          }
        } else if (response.messageStop) {
          stopReason = response.messageStop.stopReason;
          // A tool_use stop is an internal step, so it is not reported to the
          // frontend. Keep looping either way: metadata arrives after this.
          if (stopReason !== 'tool_use') {
            yield streamingChunk({ text: '', stopReason });
          }
        } else if (response.metadata?.usage) {
          yield streamingChunk({
            text: '',
            metadata: { usage: response.metadata.usage } as Metadata,
          });
        }
      }

      // The model answered instead of asking for a search: we are done
      if (stopReason !== 'tool_use') {
        return;
      }

      // The model asked for a search but the budget is used up
      if (round > MAX_SEARCH_ROUNDS) {
        yield streamingChunk({ text: '', stopReason: 'end_turn' });
        return;
      }

      const toolUseBlocks = [...blocks.values()].flatMap((block) =>
        block.type === 'toolUse' ? [block] : []
      );
      conversation.push({
        role: ConversationRole.ASSISTANT,
        content: toContentBlocks(blocks),
      });

      const searchAllowed = round < MAX_SEARCH_ROUNDS;
      const queries = toolUseBlocks.map(
        (block) => (parseToolInput(block.input).query as string) ?? ''
      );

      if (searchAllowed) {
        for (const query of queries) {
          yield streamingChunk({
            text: '',
            trace: `\n\n---\n\n🔍 **${WEB_SEARCH_TOOL}** (${ENGINE_LABELS[searchEngine]}): ${query}\n`,
          });
        }
      }

      const results = await Promise.all(
        toolUseBlocks.map(async (block, i) => {
          if (!searchAllowed) {
            return {
              block,
              text: 'The search budget for this message is used up. Answer with the information you already have and state what remains uncertain.',
              status: 'error' as const,
            };
          }
          if (!queries[i]) {
            return {
              block,
              text: 'No query was given. Call the tool again with a query, or answer without searching.',
              status: 'error' as const,
            };
          }
          try {
            const result = await searchWeb(queries[i], searchEngine);
            return {
              block,
              text: formatToolResult(result),
              trace: formatSearchTrace(result),
              usage: result.usage,
              status: 'success' as const,
            };
          } catch (e) {
            console.error(`Web search (${searchEngine}) failed`, e);
            const message = e instanceof Error ? e.message : String(e);
            return {
              block,
              text: `The web search failed: ${message}\nAnswer without it and tell the user the search was unavailable.`,
              trace: `\n\n⚠️ ${message}\n\n`,
              status: 'error' as const,
            };
          }
        })
      );

      for (const result of results) {
        if (result.trace) {
          yield streamingChunk({ text: '', trace: result.trace });
        }
        if (result.usage) {
          yield searchUsageChunk(result.usage);
        }
      }

      const toolResults: ContentBlock[] = results.map((result) => ({
        toolResult: {
          toolUseId: result.block.toolUseId,
          content: [{ text: result.text }],
          status: result.status,
        },
      }));

      conversation.push({
        role: ConversationRole.USER,
        content: toolResults,
      });
    }
  } catch (e) {
    console.error(e);
    if (
      e instanceof ThrottlingException ||
      e instanceof ServiceQuotaExceededException
    ) {
      yield streamingChunk({
        text: '',
        stopReason: 'error',
        errorCode: 'THROTTLING',
      });
    } else if (e instanceof AccessDeniedException) {
      yield streamingChunk({
        text: '',
        stopReason: 'error',
        errorCode: 'ACCESS_DENIED',
      });
    } else {
      // Search failures never get here (they become tool results above), so
      // this is the conversation model rejecting the request: tell the user
      // why, as the normal chat does (#1789).
      yield streamingChunk({
        text: '',
        stopReason: 'error',
        errorCode: classifyStreamingError(e),
      });
    }
  }
};

// Web grounding needs the Converse API with tool use, so only Bedrock text
// models can be used. Anything else falls back to a plain chat.
export const isWebGroundingSupported = (model: Model): boolean =>
  model.type === 'bedrock' && !!BEDROCK_TEXT_GEN_MODELS[model.modelId];
