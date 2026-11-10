# Google Workspace MCP (Use Google Drive and More from Agent Builder)

This feature lets GenU Agent Builder agents use Google's official Google Workspace MCP servers (Developer Preview) **with the permissions of each user's own Google account**. It is disabled by default; its resources and menu items are created only when `googleWorkspaceMcpEnabled: true` is set.

Besides reading, agents can **create email drafts, add calendar events, create new Drive files and edit Docs / Sheets / Slides**. They cannot send email, change, delete or answer events, delete or share files, or post to Chat (those tools are not given to the model).

| Name in mcp.json          | Product                                            | Read tools                                                                  | Write tools                                                                    |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `google-workspace-search` | Universal Search (Drive, Gmail, Calendar, Chat)    | `search_corpus`                                                             | None                                                                           |
| `google-gmail`            | Gmail                                              | `search_threads` `get_thread` `get_message` `list_labels` `list_drafts`     | `create_draft` (drafts only, cannot send)                                      |
| `google-calendar`         | Google Calendar                                    | `list_calendars` `list_events` `get_event` `search_events` `suggest_time`   | `create_event` (add only)                                                      |
| `google-drive`            | Google Drive                                       | `search_files` `list_recent_files` `get_file_metadata` `read_file_content`  | `create_file` (new files only)                                                 |
| `google-docs`             | Google Docs                                        | `read_doc`                                                                  | `update_doc`                                                                   |
| `google-sheets`           | Google Sheets                                      | `get_spreadsheet` `get_values`                                              | `update_values` `update_formulas` `insert_dimension` `update_spreadsheet`      |
| `google-slides`           | Google Slides                                      | `read_presentation` `read_slide_page`                                       | `update_presentation`                                                          |
| `google-chat`             | Google Chat                                        | `search_conversations` `search_messages` `list_messages` `list_memberships` | None                                                                           |
| `google-people`           | People API (organization directory, contacts)      | `get_user_profile` `search_directory_people` `search_contacts`              | None                                                                           |
| `office-documents`        | (Built into the GenU runtime, not a Google server) | None                                                                        | Create PowerPoint, Excel, Word and PDF files, save to Google Drive (see below) |

Other Google MCP servers such as Google Classroom are not included. You can add them as described in [Adding a Google product](#adding-a-google-product).

- Google documentation: [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers)
- AWS documentation: [OAuth 2.0 authorization URL session binding](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html)

## What it does

1. Each user links their own Google account under "Google Workspace" on the settings page. Pages that need the link (the assistant below, agents that use a Google server) also show a link button, so users do not have to go to the settings page first.
2. The **"Google Workspace MCP"** item in the left menu opens a ready-made agent with every Google product above plus `time` (current time) and `office-documents` (file creation). Buttons such as "Today's briefing" or "Schedule to Excel" run without typing a prompt.
3. To build your own agent, pick `google-*` servers (marked "Needs Google link") as MCP servers in Agent Builder.
4. Searching, reading and writing in a chat happen **with the Google permissions of the user who is chatting**. For a shared agent, these are the permissions of the user who invokes it, not of its creator.

For a user who has not linked Google, the Google tools are left out and the agent replies that Google should be linked on the settings page.

### Google Workspace assistant (fixed menu item)

`/workspace-assistant` is not a saved agent but an **Agent Builder agent defined in the frontend** (`hooks/useWorkspaceAssistant.ts`). The Agent Builder chat (`AgentChatUnified`) already sends the configuration (system prompt, MCP server names, model) with every request, even for saved agents, so this page simply passes a fixed configuration to the same component. Nothing is added to DynamoDB or to the runtime.

- Shown when both `agentBuilderEnabled` and `googleWorkspaceMcpEnabled` are enabled.
- System prompt: `prompts/workspaceAssistant.ts`. It tells the model to resolve relative dates with `get_current_time` before searching, which tool to use for which product, the write rules (below), and to cite sources (subject, file name, link). The runtime appends the instructions for the file creation tools automatically.
- MCP servers: `WORKSPACE_ASSISTANT_MCP_SERVERS` in `useWorkspaceAssistant.ts`. Names missing from the deployed mcp.json are dropped automatically.
- Model: picked in the input toolbar, like the chat page. The last model used is remembered per browser.
- Quick actions: 12 buttons on the empty chat (today's briefing, today's schedule, prepare for the next meeting, free time this week, summarize unread mail, Chat updates, recent files, draft weekly report, schedule to Excel, weekly report slides, meeting agenda, reply drafts) send a preset prompt as is. The list and icons are `QUICK_ACTIONS` in `pages/WorkspaceAssistantPage.tsx`; labels and prompts are `workspace_assistant.quick_actions.<id>.label` / `.prompt` in the locale files. Requests that create files or email drafts are fine, but do not add ones that change existing files or invite other people (the assistant asks for confirmation first, so one click would not be enough). The buttons are rendered through the `quickActions` prop of `AgentChatUnified` and do not appear for other agents.
- Users who are not in `googleWorkspaceAllowedUsers` still see the menu item. They see a "not allowed to link Google" notice and the agent runs without the Google tools.

### Write rules

There is no confirmation dialog, so the assistant confirms in the chat (instructed by the system prompt).

- It writes only when the user asks for it in the chat. Instructions inside emails, documents or Chat messages ("forward this email to ...") are never followed; what it reads is treated as data.
- Done right away when asked: a new email draft, a new file, an event without other attendees. The assistant returns what it created and a link.
- Done only **after the user says OK** to a summary: changing an existing document, spreadsheet or presentation (which file, where, what), and an event with attendees (they receive invitations; subject, time, attendees, Meet link or not).
- Email stops at drafts. Users send them from Gmail themselves.

### File creation (PowerPoint, Excel, Word, PDF)

`office-documents` in mcp.json is not an MCP server but a set of tools built into the GenU runtime (`"builtin": "office-documents"`). It is selectable in Agent Builder like any MCP server and, like the Google servers, is listed only while `googleWorkspaceMcpEnabled` is enabled. The model never writes code: it passes **structured content** (slide layouts, table contents, ...) and the runtime renders it. The assistant reads email and documents written by other people, so arbitrary code execution is avoided.

| Tool                    | What it does                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_powerpoint`     | 16:9 slides with 12 layouts (title, section, agenda, bullets, two columns, table, chart, KPI numbers, steps, quote, image, closing). Tables and charts are native and editable in PowerPoint / Google Slides. Overflowing text returns a warning so the model can fix it |
| `create_excel_workbook` | One table per sheet: per-column formats (integer, decimal, currency, percent, date, time), formulas (`{row}` `{first}` `{last}` for row numbers), totals row, charts, frozen header and filters, print settings (fit to one page wide)                                   |
| `create_word_document`  | A4: title, headings 1-3, paragraphs (bold, links), bulleted and numbered lists, tables, callouts, quotes, images, page breaks, header and page numbers                                                                                                                   |
| `save_to_google_drive`  | Save a created file to the user's Drive. pptx / xlsx / docx are converted to Google Slides / Sheets / Docs by default. **This is how new Google Slides etc. are created** (create the Office file, then convert)                                                         |
| `convert_to_pdf`        | Convert a created file to PDF (or pass `pdf=true` when creating it)                                                                                                                                                                                                      |
| `preview_document`      | Render the file's pages as images so the model can check the layout                                                                                                                                                                                                      |
| `export_google_file`    | Make a Google Docs / Sheets / Slides file in Drive downloadable as PDF or Office format                                                                                                                                                                                  |

- **Files are created only when the user explicitly asks for one** (names a format such as Word, Excel, PowerPoint, PDF, slides or Google Docs, or says "export" / "make it downloadable"). Other requests ("summarize my week") are answered in the chat, and **"turn this answer into a file" buttons** (Word / PowerPoint / Excel / PDF / Google Docs) appear under the answer. A button sends a request such as "Turn the content of your previous answer into a Word file." and the assistant converts the answer without searching again. The list is `EXPORT_ACTIONS` in `pages/WorkspaceAssistantPage.tsx`, labels and requests are `workspace_assistant.export_actions.<id>` in the locale files, and they are rendered through the `followUpActions` prop of `AgentChatUnified`. They are not shown under an answer that already created a file.
- **Preview in GenU**: when Google is linked, the runtime also stores the PDF and images of the first 20 pages of each created file in S3 under the same key base (`<uuid>.pdf`, `<uuid>.page-01.png`, ... for `<uuid>.docx`). The chat finds the links to created files in an answer and shows page thumbnails and a download button under it, with a zoom viewer (`components/agentBuilder/GeneratedFilePreview.tsx`; link detection in `utils/generatedFiles.ts`). The PDF is not embedded in an iframe because the web CSP (`frame-src`) does not allow S3, and the page count is found by loading page images in order because the bucket has no CORS (JavaScript cannot list or read it). Without a Google link there are no page images, so only the link is shown.
- Created files are stored in S3 (under `agentcore/` in the AgentCore file bucket) and appear in the chat as download links. Keys are ASCII only; the original (possibly non-ASCII) file name is set in Content-Disposition, because non-ASCII keys break in Markdown links and the signed URL API. A file created in an earlier turn can be converted to PDF or saved to Drive by passing its URL (while `googleWorkspaceMcpEnabled` is enabled, the runtime role gets read access to `agentcore/*`).
- One font is used throughout: **BIZ UDPGothic** (bundled with Windows 10 and later and available on Google Fonts, so conversion to Google formats keeps the layout). There are 6 color schemes, and a brand color can be specified.
- **PDFs and previews are made in the user's Google Drive** (with a link, on every file creation for the preview; this takes a few seconds). The Office file is uploaded converted to a Google format, exported as PDF and deleted right away (for a few seconds Drive holds a file named "... (PDF conversion, deleted automatically)"). Installing LibreOffice in the runtime would bring the image close to AgentCore's 2 GB limit, hence this approach. PDF conversion, previews, saving to Drive and exporting therefore need a Google link (a google-drive server with `drive.file`); without one only the Office files are created.
- Excel formulas are calculated by Excel / Google Sheets when the file is opened (they are not calculated or validated at creation). A PDF of an Excel file uses the default layout of Google Sheets.

## How it works

Storing, encrypting and refreshing Google tokens is left to the **AgentCore Identity Token Vault**; nothing is stored in GenU's DynamoDB.

```
[Settings page "Link Google"]
  │ POST /google-workspace/authorize   (API Gateway Cognito authorizer → monolith Lambda)
  │   GetWorkloadAccessTokenForUserId(GenU's own workload identity, "cognito+<sub>")
  │   GetResourceOauth2Token(USER_FEDERATION, scopes, returnUrl, access_type=offline)
  │   → Google consent URL
  ▼
[Google consent screen]
  ▼  AgentCore Identity callback → GenU /google-workspace/callback?session_id=...
[Callback page]
  │ POST /google-workspace/complete
  │   CompleteResourceTokenAuth(sessionUri, userId="cognito+<sub>")
  │   → stored in the Token Vault only if the user who started and the user who completed match
  ▼
[Agent Builder chat]
  │ POST /google-workspace/token → the user's own Google access token (valid for about 1 hour)
  │ sent as google_access_token in the InvokeAgentRuntime payload (existing SigV4 path)
  ▼
[AgentCore runtime (src/tools.py)]
    For servers with auth.type = google-oauth in mcp.json only, MCP clients dedicated to this
    request (Streamable HTTP + Authorization: Bearer) are created in parallel and closed afterwards
```

The token travels through the browser because the AgentCore runtime is invoked directly from the browser with the shared Identity Pool role, so the runtime cannot tell which user is calling (and a workload identity that the runtime manages itself cannot hand tokens to its caller).

The runtime adds different notes to the system prompt when there is no token (not linked, or missing scopes) and when there is a token but the connection failed (an API not enabled, or an outage on Google's side), so that the latter does not tell the user to link Google.

### Keeping one user's token away from others

- **Who the user is**: the token owner is decided only by the `sub` claim verified by the API Gateway Cognito authorizer. IDs in the request body or headers are never used (AgentCore Identity does not verify the user ID it is given).
- **Session binding**: even if a consent URL reaches someone else, `CompleteResourceTokenAuth` stores the token only when the user who started the consent and the one who completes it match (the URL expires after 10 minutes).
- **Runtime**: Google MCP clients are created and closed per request. Google servers are never put on the existing paths that are shared and cached across requests (`load_mcp_tools` / `load_mcp_tools_by_names`).
- **Permissions**: one workload identity is created for GenU only, and the IAM permissions to get tokens are granted only to the monolith Lambda, limited to that ARN and the credential provider from step 2.
- **Handling the token**: the access token is kept in browser memory only, never stored in chat history or localStorage, and never logged (the payload log in `useAgentCoreApi.ts` masks it).
- **Confirmation forms (elicitation)**: if Google asks for confirmation, GenU has no UI to show it to the user, so the runtime always declines. According to Google's documentation, confirmation forms appear with domain-wide delegation (an administrator acting for users), so they are not expected with the per-user OAuth GenU uses (if writes fail with a decline, check this). Confirmation before writes happens in the chat as described in "Write rules".

## Enabling the feature

### 1. Google Cloud

`<your-gcp-project>` below is the ID of the Google Cloud project that holds the OAuth client.

1. Enable the product APIs and MCP services (the People API uses the same name for both; Universal Search has only `workspacemcp.googleapis.com`).

   ```bash
   gcloud services enable \
     drive.googleapis.com drivemcp.googleapis.com \
     gmail.googleapis.com gmailmcp.googleapis.com \
     calendar-json.googleapis.com calendarmcp.googleapis.com \
     docs.googleapis.com docsmcp.googleapis.com \
     sheets.googleapis.com sheetsmcp.googleapis.com \
     slides.googleapis.com slidesmcp.googleapis.com \
     chat.googleapis.com chatmcp.googleapis.com \
     people.googleapis.com \
     workspacemcp.googleapis.com \
     --project=<your-gcp-project>
   ```

2. Configure the consent screen under "Branding" and "Audience" of Google Auth Platform. If only users of your Google Workspace organization will use it, the **Internal** user type is recommended. There is one consent screen per project, so if one is already configured for another purpose, its app name is shown to GenU users as well.
3. With the Internal user type, registering scopes under "Data access" is **not needed** ([Google documentation](https://developers.google.com/workspace/guides/configure-oauth-consent): "For apps used only internally by your Google Workspace organization, scopes aren't listed on the consent screen"). GenU requests the actual scopes when it creates the consent URL, from the union of the `scopes` in mcp.json (`GOOGLE_WORKSPACE_SCOPES`). With the External user type, register the scopes there and check whether Google's verification is required.
4. Under "Clients", create an OAuth client of type **Web application** and **check "Use this client for an AI-powered agent"** (without it, requests to the MCP servers are rejected). Leave the redirect URIs empty for now and note the client ID and secret.

### 2. AWS: create the OAuth2 credential provider

To keep the client secret out of cdk.json, Git and the CloudFormation template, create the provider by hand with the CLI. AgentCore Identity stores the secret in Secrets Manager. Use the Region of the main stack (`GenerativeAiUseCasesStack`). The name (`genu-google-workspace`) is up to you.

```bash
read -r -p 'Client ID: ' GOOGLE_CLIENT_ID
read -r -s -p 'Client secret: ' GOOGLE_CLIENT_SECRET; echo
aws bedrock-agentcore-control create-oauth2-credential-provider \
  --region <region> \
  --name genu-google-workspace \
  --credential-provider-vendor GoogleOauth2 \
  --oauth2-provider-config-input "{\"googleOauth2ProviderConfig\":{\"clientId\":\"$GOOGLE_CLIENT_ID\",\"clientSecret\":\"$GOOGLE_CLIENT_SECRET\"}}" \
  --query callbackUrl --output text
unset GOOGLE_CLIENT_SECRET
```

Register the printed `https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/...` as an **authorized redirect URI** of the OAuth client from step 1-4 (not the GenU URL).

### 3. cdk.json

```json
"agentBuilderEnabled": true,
"googleWorkspaceMcpEnabled": true,
"googleWorkspaceCredentialProviderName": "genu-google-workspace",
"googleWorkspaceAllowedUsers": ["*"]
```

| Parameter                               | Description                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `googleWorkspaceMcpEnabled`             | Enables the feature (default `false`). While `false`, no workload identity, API route, environment variable or menu item is created                                                                   |
| `googleWorkspaceCredentialProviderName` | Name of the credential provider created in step 2 (required when enabled)                                                                                                                             |
| `googleWorkspaceAllowedUsers`           | Users who may link Google. `["*"]` allows everyone who can sign in to GenU. To limit it, list GenU sign-in names (`cognito:username`); email addresses are not matched. Empty (default) allows no one |

The Google servers run on the Agent Builder runtime, so `agentBuilderEnabled` is required as well.

### 4. Deploy and check

1. Deploy with `npm run cdk:deploy`.
2. On the GenU settings page, press "Link Google" under "Google Workspace", consent, and check that "Your Google account is linked" is shown.
3. Open "Google Workspace MCP" in the left menu and press a button such as "Today's schedule", or ask "Summarize this week's unread email" or "Which Drive files did I update recently?".

The consented scopes also include the scopes the GenU API uses itself (`GOOGLE_API_SCOPES` in `lib/construct/google-workspace.ts`, currently none).

After a deployment that adds scopes, users who had linked Google are shown as not linked again (their stored token lacks the new scopes). Ask them to link again on the settings page.

The return URLs are built from the same allowed origins as CORS (`allowedOrigins`; by default the GenU URL). The sign-in state is per origin, so the consent returns to the origin it started from. Adding another domain to `allowedOrigins` adds it to the return URLs as well.

## Unlinking

GenU has no unlink button. "Unlink" on the settings page opens "Third-party apps & services" of the Google account, where the access can be removed. To use it again, press "Link again" (`forceAuthentication` starts a fresh consent).

## Limitations and open points

- **Developer Preview**: Google's side may change.
- **Scope of writes**: `allowedTools` limits writes to drafts, adding events, creating files and editing documents. The scopes themselves (`gmail.compose`, ...) allow more, so do not remove or widen `allowedTools`.
- **PDFs go through Google**: as described in "File creation", PDFs and previews need a Google link.
- **Refresh tokens**: Google issues a refresh token only with `access_type=offline`. GenU requests it, but if the Token Vault does not store and refresh it, users have to link again about every hour.
- **Account mapping**: the GenU sign-in and the Google account are separate. The link is per GenU user, and the Google account the user consented with is used (email addresses are not compared).
- **Not in the generic AgentCore page**: the Google servers are only in the Agent Builder `agent-builder/mcp.json`.
- **Runtime image**: python-pptx, python-docx, XlsxWriter and pypdfium2 are added to the runtime for `office-documents` (they are in the image even while the feature is disabled).
- **Environment variable size**: the consented scopes go into the monolith Lambda's `GOOGLE_WORKSPACE_SCOPES` environment variable. Lambda environment variables are limited to 4 KB in total, so be careful when adding many scopes or `googleWorkspaceAllowedUsers` entries.
- **Closed network mode**: not tested with `closedNetworkMode`.

## Adding a Google product

Add an entry to `packages/cdk/lambda-python/generic-agent-core-runtime/mcp-configs/agent-builder/mcp.json` (the bundled Gmail entry as an example):

```json
"google-gmail": {
  "url": "https://gmailmcp.googleapis.com/mcp/v1",
  "auth": {
    "type": "google-oauth",
    "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]
  },
  "toolPrefix": "google_gmail",
  "allowedTools": ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "create_draft"],
  "metadata": { "category": "Google Workspace", "description": "..." }
}
```

- The union of the `scopes` of all Google servers is what users consent to (`collectGoogleOAuthScopes`). When scopes are added, existing users are shown as not linked and have to link again.
- `allowedTools` lists Google's own tool names (before the prefix). When adding a write tool, review the forbidden list in the tests, the allowed scopes and the assistant's write rules. Never add tools that send, delete or share.
- On the Google Cloud side, enable the product's API and MCP service (e.g. `gmail.googleapis.com` and `gmailmcp.googleapis.com`).
- To use it in the Google Workspace assistant too, add the name to `WORKSPACE_ASSISTANT_MCP_SERVERS` in `hooks/useWorkspaceAssistant.ts` and describe when to use its tools in `prompts/workspaceAssistant.ts`.
- The tests (`test/construct/googleWorkspace.test.ts`) check that the bundled mcp.json requests only read scopes (`.readonly`, `calendar.events.freebusy`, `userinfo.profile`) and the reviewed write scopes (`gmail.compose` `calendar.events` `drive.file` `documents` `spreadsheets` `presentations`), that every Google server has `allowedTools`, that no tool sends, deletes, shares or changes events, and that nothing is added to the frontend list while the feature is disabled.

## Where things are

| Role                                                              | Files                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameters                                                        | `packages/cdk/lib/stack-input.ts`, `packages/cdk/cdk.json`                                                                                                                                                                                                                                           |
| Workload identity, IAM, API routes                                | `packages/cdk/lib/construct/google-workspace.ts`, `packages/cdk/lib/utils/token-vault-access.ts`                                                                                                                                                                                                     |
| Loading mcp.json (`url` / `auth` / `allowedTools` / `toolPrefix`) | `packages/cdk/lib/utils/mcp-config-loader.ts`                                                                                                                                                                                                                                                        |
| API (`/google-workspace/status` `authorize` `complete` `token`)   | `packages/cdk/lambda/api/routes/googleWorkspace.ts`, `lambda/googleWorkspace.ts`, `lambda/utils/googleWorkspaceIdentity.ts`, `lambda/utils/agentCoreTokenVault.ts`, `lambda/utils/userIntegration.ts`                                                                                                |
| Runtime                                                           | `lambda-python/generic-agent-core-runtime/src/tools.py` (`load_user_token_mcp_tools`), `src/agent.py`, `app.py`                                                                                                                                                                                      |
| UI                                                                | `pages/Setting.tsx`, `pages/GoogleWorkspaceCallbackPage.tsx`, `hooks/useGoogleWorkspace.ts`, `hooks/useIntegrationLink.ts`, `components/IntegrationNotice.tsx`, `components/IntegrationCallback.tsx`, `components/agentBuilder/AgentChatUnified.tsx`, `components/agentBuilder/MCPServerManager.tsx` |
| Google Workspace assistant                                        | `pages/WorkspaceAssistantPage.tsx`, `hooks/useWorkspaceAssistant.ts`, `prompts/workspaceAssistant.ts`, `hooks/useAgentChatExtensions.ts`, `components/agentBuilder/AgentQuickActions.tsx`, `components/agentBuilder/AgentAnswerExtras.tsx`                                                           |
| File creation (office-documents)                                  | `lambda-python/generic-agent-core-runtime/src/documents/` (`toolset.py`: tools and prompt, `*_builder.py`: rendering, `google_files.py`: Drive transfer and PDF conversion), `src/tools.py` (`load_builtin_tools`)                                                                                   |
| Tests                                                             | `packages/cdk/test/lambda/googleWorkspace.test.ts`, `packages/cdk/test/construct/googleWorkspace.test.ts`, `lambda-python/generic-agent-core-runtime/tests/`, `packages/web/tests/components/generatedFiles.test.ts`                                                                                 |
