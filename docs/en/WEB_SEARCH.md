# Web Search Chat (Amazon Nova Web Grounding / Amazon Bedrock Web Search)

This page describes the "Web Search Chat" use case (`/web-search`), listed below Chat in the menu. It is disabled by default; the menu item and the page appear only when `webGroundingEnabled` is `true`.

## What it does

The page is the regular chat, except that **the model the user selected is given a `web_search` tool**.

1. The user asks a question
2. The model calls `web_search` only when it decides that its own knowledge may be outdated or uncertain
3. The backend runs the actual web search with the **search engine** selected on the page (see "Switching the search engine" below)
4. The text of the search results and the source URLs go back to the model as the tool result
5. The model analyzes them, answers, and cites the sources it used as Markdown links

Whether to search is up to the model, so small talk or translation does not trigger a search. When needed, it sends several queries in one turn or searches again. The queries and sources are shown in the collapsible "trace" above the answer. The search model (Nova / GPT), the number of searches and its input / output tokens are shown with a 🔍 next to the conversation model's token counts below the answer (they are not included in the token statistics).

### Switching the search engine (Nova / GPT)

The engine that runs the searches behind the `web_search` tool can be selected with "Search engine" in the input toolbar at the bottom of the page, next to the model selector. The conversation model itself does not change. The choice is stored per browser (localStorage `webSearchEngine`) and applies from the next message.

**GPT is the default whenever it is configured.** Nova is used only when the user explicitly selected it (stored value `nova`) or when `webGroundingGptModelId` is not set. The Lambda function applies the same rule, so a request without `webSearchEngine` (e.g. from an old browser tab) also searches with GPT.

| Engine                             | How it works                                                                                                                                                        | Notes                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GPT (Bedrock Web Search) (default) | Calls GPT-5.4 or later (`webGroundingGptModelId`) with **Amazon Bedrock Web Search** (the `web_search` server-side tool) through the `bedrock-mantle` Responses API | Selectable only when `webGroundingGptModelId` is set. GPT re-searches and fetches page content on its own, so it can take longer than Nova |
| Amazon Nova                        | Calls the **web grounding system tool** of Nova 2 (`webGroundingModelId`) through the Converse API                                                                  | Always available. The only engine when GPT is not configured                                                                               |

Implementation notes on the GPT engine:

- Web Search is available **only on the Responses API** of the `bedrock-mantle` endpoint, not through the Converse API / `bedrock-runtime`. `bedrockWebSearchApi.ts` therefore calls it with a plain **fetch signed with SigV4 (service name `bedrock-mantle`)** using the Lambda execution role's credentials. No Bedrock API key and no OpenAI SDK are used.
- `external_web_access: false` is **always sent explicitly**. The default is `true`, which requires the `bedrock-websearch:ExternalWebAccess` permission; without it every page fetch fails. With `false`, retrieval stays within the Bedrock web index and cache, and no data leaves AWS.
- It is called with `reasoning.effort: low` and `store: false` (the response is not stored on the server). `user_location` is not set.
- GPT writes its citations inline as Markdown links, and the `url_citation` annotations point at those links. So **a paragraph containing a cited link becomes an `<excerpt>` backed by that source, and a paragraph without one becomes `<unsourced>`**, the same tool-result format as Nova. The queries GPT actually ran internally are shown in the trace, prefixed with `↳`.
- The GPT engine does not support cross-account Bedrock (`crossAccountBedrockRoleArn`). It always uses the Lambda function's own role.

### Division of roles (the search engine does no reasoning)

Sending a **complex question such as "the difference between A and B" straight to the search engine makes it hallucinate**: it merges companies with similar names or invents parent / subsidiary relationships that no source states, and the conversation model then takes those as facts.

The roles are therefore split as follows.

- **The search engine only looks things up and extracts.** Each query is limited to one subject and one point, and the engine is told to report only what a source literally says (`groundingSystemPrompt()`).
- **Comparing, combining and concluding is the conversation model's job** (Claude, etc.). It is told to break a complex question into simple single-subject queries before searching (the `web_search` tool description and the system prompt).
- The tool result **separates `<excerpt sources="1,2">` passages backed by sources from `<unsourced>` text**. The latter is the search engine's own wording, where it tends to make things up, so the conversation model is told to treat it as an unverified hint and not to relate two things unless a single excerpt says so directly.

### Telling the models today's date

Models **do not know what day it is**. Left alone, they assume their training cutoff is the present and make two mistakes:

- They add a past year to search queries
- They dismiss correct information from after their cutoff as fake because it is "dated in the future"

So both models are given the current date.

- Conversation model: `claudePrompter.systemContext('/web-search')` appends a note with the date, only for `/web-search` (the browser's local date, evaluated for every request).
- Search engine (Nova / GPT) and the `web_search` tool definition: the Lambda function embeds the UTC date (`today()` in `webGroundingApi.ts`) and tells them not to put a past year in queries, to prefer recently updated pages, and to always state the year or "as of" date a page gives.

Conversations continue as usual and are saved to the history like a regular chat. Note that reopening one from the history opens `/chat/:chatId`, so continuing it there is **a regular chat without web search** (the same behavior as the other use cases).

References: [Amazon Nova web grounding (AWS documentation)](https://docs.aws.amazon.com/nova/latest/nova2-userguide/web-grounding.html) / [Amazon Bedrock Web Search (AWS documentation)](https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html)

## Enabling

Set the following in the `context` of `packages/cdk/cdk.json` (or in `parameter.ts`) and deploy. The Lambda function (`WebGroundingStream`), the menu item and the route are created only when `webGroundingEnabled` is `true`. With `false` (the default), **no resources are created at all**.

### Example in cdk.json

```json
{
  "context": {
    "webGroundingEnabled": true,
    "webGroundingModelId": "us.amazon.nova-2-lite-v1:0",
    "webGroundingRegion": "us-east-1",
    "webGroundingGptModelId": "openai.gpt-6.1-terra",
    "webGroundingGptRegion": "us-east-1"
  }
}
```

### Example in parameter.ts

```typescript
const envs: Record<string, Partial<StackInput>> = {
  dev: {
    webGroundingEnabled: true,
    // Only when the GPT engine is also used
    webGroundingGptModelId: 'openai.gpt-6.1-terra',
  },
};
```

| Parameter                | Default                      | Description                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webGroundingEnabled`    | `false`                      | Turns the whole feature on / off                                                                                                                                                                                                      |
| `webGroundingModelId`    | `us.amazon.nova-2-lite-v1:0` | Nova 2 model that runs the searches                                                                                                                                                                                                   |
| `webGroundingRegion`     | `us-east-1`                  | Region in which that model is called                                                                                                                                                                                                  |
| `webGroundingGptModelId` | `''` (no GPT engine)         | Model used by the GPT engine, as `bedrock-mantle` names it (no `us.` / `global.` prefix, e.g. `openai.gpt-6.1-terra`). Must be GPT-5.4 or later and list server-side tool support on its model card (GPT-6.1 Sol does not support it) |
| `webGroundingGptRegion`  | `us-east-1`                  | Region in which the GPT engine is called (`us-east-1` / `us-east-2` / `us-west-2` only)                                                                                                                                               |

Then deploy with `npm run cdk:deploy`.

## Limitations and notes

- **US only**: web grounding works only with Nova 2 models in US regions / US CRIS profiles (`us.` prefix). Setting `webGroundingRegion` to a non-US region fails. The conversation models (`modelIds`) can stay in any region.
- **The GPT engine is US only, too**: Bedrock Web Search is available only for GPT-5.4 or later in us-east-1 / us-east-2 / us-west-2, and some models are limited to fewer regions (GPT-6.1 Terra: us-east-1 only). The Lambda role is granted `bedrock-mantle:CreateInference` and `bedrock-websearch:InvokeSearch` / `InvokeFetch` (not `ExternalWebAccess`). Calls fail if an SCP denies `bedrock-mantle:*` or `bedrock-websearch:*`.
- **SCPs**: web grounding calls arrive with `aws:requestedRegion` set to `unspecified`, so an SCP / IAM policy that pins regions blocks them (the error is shown in the trace).
- **Additional charges**: each search is charged as web grounding / Web Search usage. The GPT engine additionally incurs GPT's own token charges ([Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)). The number of searches is capped (at most 5 rounds per message).
- **Citations are required**: under the AWS terms, grounded results must be shown with their citations and links. The model is told so both in the system prompt and in the tool result; if you edit the system prompt, keep that instruction.
- **Model choice**: the page relies on tool use through the Converse API, so SageMaker endpoints cannot be selected on it. Selecting a Bedrock model without tool use support results in an error (Claude, Nova, GPT and others support it). The model and the search engine are selected in the input box at the bottom, as in the regular chat.
- **Searching in languages other than English**: according to the AWS documentation, the runtime filters against indirect prompt injection and misinformation are less effective for non-English content.

## Where it is implemented

| Role                                                      | File                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Streaming Lambda function (invoked directly)              | `packages/cdk/lambda/webGroundingStream.ts`          |
| Tool loop and the Nova call                               | `packages/cdk/lambda/utils/webGroundingApi.ts`       |
| GPT (Bedrock Web Search) call                             | `packages/cdk/lambda/utils/bedrockWebSearchApi.ts`   |
| Conditional creation of the Lambda function               | `packages/cdk/lib/construct/api.ts`                  |
| Parameter definitions                                     | `packages/cdk/lib/stack-input.ts`                    |
| Page (thin wrapper around ChatPage + engine selector)     | `packages/web/src/pages/WebSearchChatPage.tsx`       |
| Feature flag, path and stored engine choice               | `packages/web/src/hooks/useWebGrounding.ts`          |
| Switching the target Lambda function + sending the engine | `packages/web/src/hooks/useChatApi.ts`               |
| System prompt                                             | `packages/web/src/prompts/claude.ts` (`/web-search`) |
