# Deploying Image / Video Generation (Gemini / GPT Image)

This page describes how to set up the features that generate images and videos by calling external generative AI APIs from GenU. Both are off by default: resources are created and the menu items are shown only when the feature is configured.

- [Gemini image / video generation](#gemini-image--video-generation): uses Google's Gemini API (Workload Identity Federation, no API key)
- [GPT Image generation / editing](#gpt-image-generation--editing): uses OpenAI's Images API (API key)

Both share one image page, which also offers [image generation from a chat](#image-generation-from-a-chat) and [saving all images as one PDF](#saving-all-images-as-one-pdf).

## Gemini image / video generation

GenU calls Google's Gemini API to generate and edit images (the Nano Banana family) and videos (Gemini Omni Flash).

- Images: `generateContent` of Vertex AI (`aiplatform.googleapis.com`)
- Videos: the `interactions` endpoint of the Gemini API (`generativelanguage.googleapis.com`)

Authentication is **Workload Identity Federation (WIF)**. **No API key is used.** The Lambda execution role (AWS credentials) is exchanged for a Google access token, and the Google APIs are called with the permissions of the service account you specify.

```
Frontend ──(direct invoke with IAM auth)──▶ invokeGemini Lambda
    AWS credentials of the Lambda execution role
        │ (1) build a SigV4-signed GetCallerIdentity request
        ▼
    Google STS (sts.googleapis.com) ── token exchange
        │ (2) federated token
        ▼
    iamcredentials.googleapis.com ── service account impersonation (generateAccessToken)
        │ (3) access token (scope: cloud-platform + generative-language.retriever)
        ▼
    aiplatform.googleapis.com (images) / generativelanguage.googleapis.com (videos)
```

Results are stored in the existing `fileBucket` (S3) and recorded automatically as chat history (`/gemini-image`, `/gemini-video`).

### Required parameters

The Google-side setup described below produces three values. Set them in `packages/cdk/cdk.json` and deploy to enable the feature (it does not appear in the menu until they are set).

```json
{
  "context": {
    "geminiWifAudience": "//iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider",
    "geminiServiceAccountEmail": "genu-gemini@<PROJECT_ID>.iam.gserviceaccount.com",
    "geminiProjectId": "<PROJECT_ID>",
    "geminiImageModel": "gemini-nano-banana-2.1",
    "geminiImageModels": ["gemini-3-pro-image"],
    "geminiImageLocation": "global",
    "geminiVideoModel": "gemini-omni-1.2-flash",
    "geminiVideoModels": []
  }
}
```

| Parameter                   | Description                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geminiWifAudience`         | Full resource name of the WIF provider (`//iam.googleapis.com/...`). Note that it uses the **project number** (digits)                                                                                                                      |
| `geminiServiceAccountEmail` | Email address of the service account to impersonate                                                                                                                                                                                         |
| `geminiProjectId`           | Google Cloud project ID                                                                                                                                                                                                                     |
| `geminiImageModel`          | Default image model. Default `gemini-nano-banana-2.1` (Nano Banana 2.1 / 1K to 4K). Others include `gemini-3-pro-image` (Nano Banana Pro / 1K to 4K) and `gemini-3.1-flash-image` (Nano Banana 2 / 512 to 4K, deprecated on the Gemini API) |
| `geminiImageModels`         | Additional models offered in the model selector of the image page (default `[]`). The Lambda only accepts the models listed here and in `geminiImageModel`                                                                                  |
| `geminiImageLocation`       | Location of the image model. Default `global`                                                                                                                                                                                               |
| `geminiVideoModel`          | Default video model. Default `gemini-omni-1.2-flash`. `gemini-omni-flash-preview` was shut down on 2026-10-22                                                                                                                               |
| `geminiVideoModels`         | Additional models offered in the model selector of the video page (default `[]`)                                                                                                                                                            |

### Google Cloud setup

The steps below use the gcloud CLI (they can be run in Cloud Shell). See the note under each step for the Console.

Decide these values first:

- `PROJECT_ID`: the Google Cloud project ID
- `AWS_ACCOUNT_ID`: the AWS account ID (12 digits) GenU is deployed in

```bash
export PROJECT_ID="<PROJECT_ID>"
export AWS_ACCOUNT_ID="123456789012"
gcloud config set project "${PROJECT_ID}"
```

#### 1. Enable the APIs

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  generativelanguage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

- `aiplatform.googleapis.com`: image generation (Vertex AI)
- `generativelanguage.googleapis.com`: video generation (Gemini API)
- `iamcredentials.googleapis.com` / `sts.googleapis.com`: needed for the WIF token exchange and the service account impersonation

> In the Console: "APIs & Services" → "Library", then search for and enable the four APIs above.

#### 2. Create the Workload Identity pool and the AWS provider

```bash
gcloud iam workload-identity-pools create genu-aws-pool \
  --location=global \
  --display-name="GenU AWS"

gcloud iam workload-identity-pools providers create-aws genu-aws-provider \
  --location=global \
  --workload-identity-pool=genu-aws-pool \
  --account-id="${AWS_ACCOUNT_ID}" \
  --attribute-mapping="google.subject=assertion.arn.extract('assumed-role/{role}/'),attribute.account=assertion.account,attribute.aws_role=assertion.arn.extract('assumed-role/{role}/')"
```

> **`--attribute-mapping` is required.** The default of `create-aws` is `google.subject = assertion.arn`, but the assumed-role ARN, which contains the role name CDK generates plus the Lambda function name (session name), exceeds Google's 127-byte limit for `google.subject`, so the token exchange fails with `The size of mapped attribute google.subject exceeds the 127 bytes limit` (400). Map only the role name to the subject as shown above. Authorization is done with `attribute.account` (step 4), so changing the subject does not affect the permissions.
>
> A provider that was already created with the default mapping can be fixed without redeploying by updating it with the same `--attribute-mapping`: `gcloud iam workload-identity-pools providers update-aws genu-aws-provider --location=global --workload-identity-pool=genu-aws-pool --attribute-mapping=...`.

> In the Console: "IAM & Admin" → "Workload Identity Federation" → "Create pool". Choose "AWS" as the provider type and enter the AWS account ID. Change `google.subject` in the attribute mapping to the value above.

#### 3. Create the service account and grant roles

```bash
gcloud iam service-accounts create genu-gemini \
  --display-name="GenU Gemini (image/video generation)"

# For image generation (Vertex AI generateContent)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# For video generation (generativelanguage is called with x-goog-user-project)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"
```

> In the Console: "IAM & Admin" → "Service Accounts" → "Create service account". Grant the "Vertex AI User" and "Service Usage Consumer" roles.

#### 4. Allow AWS to impersonate the service account

Allow AWS principals authenticated through the WIF pool to impersonate the service account (`roles/iam.workloadIdentityUser`).

```bash
export PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
  "genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/attribute.account/${AWS_ACCOUNT_ID}"
```

> This allows **every IAM role in the AWS account** to impersonate the service account. To limit it to the execution role of the invokeGemini Lambda, look up the execution role name of the `InvokeGemini` function in CloudFormation (the stack's resource list) after deploying, and replace the binding with one whose member is `attribute.aws_role/<role name>` (note that the role name can change on redeploy).

#### 5. Put the values in cdk.json

```bash
echo "geminiWifAudience: //iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider"
echo "geminiServiceAccountEmail: genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com"
echo "geminiProjectId: ${PROJECT_ID}"
```

Set the three printed values in `context` of `packages/cdk/cdk.json` and deploy GenU. After the deployment, "Image Generation & Editing", "Video Generation & Editing" and "Manga Generation" appear in the menu (the image page and the manga page are shared with GPT Image; for the manga page see [MANGA.md](./MANGA.md)).

### Features and limits

- **Images**: generate from text, or edit with images + text (up to 4 images / 4MB in total). Aspect ratio, resolution (1K / 2K / 4K; 512 only on `gemini-3.1-flash-image`; a resolution the model does not support is adjusted automatically) and the number of images (1 to 4) can be chosen
- **Videos**: generate from text / reference images (16:9 / 9:16, MP4 with audio). There are two ways to edit:
  - **Stateful editing** of the previous result (uses the interaction ID; the video is not uploaded again)
  - Editing an uploaded video of your own (MP4 / WebM, up to 14MB). The video is uploaded to S3 and passed as an S3 URL (14MB comes from the request limit of the Gemini API, about 20MB)
- The 4MB total for images (images to edit, up to 3 reference images for a video) comes from the payload limit of a direct Lambda invoke (6MB; base64 inflates data by about 4/3). A generated result reused as editing material is passed as an S3 URL and does not count toward it
- Video generation can take several minutes (the Lambda timeout is 15 minutes)
- In the EEA (European Economic Area), Switzerland and the United Kingdom, the Gemini API does not support editing uploaded videos (stateful editing of generated results works)
- The interactions API for videos may change (`gemini-omni-flash-preview` was shut down on 2026-10-22; the default is `gemini-omni-1.2-flash`)

### Troubleshooting (Gemini)

| Symptom                                      | Cause / fix                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Google STS token exchange failed (400)`     | Wrong format of `geminiWifAudience` (use the project **number**, not the **ID**), or the pool / provider name does not match   |
| `Service account impersonation failed (403)` | The `roles/iam.workloadIdentityUser` binding of step 4 is missing, or its member is wrong                                      |
| `403 PERMISSION_DENIED` (images)             | `aiplatform.googleapis.com` is not enabled, or the service account lacks `roles/aiplatform.user`                               |
| `403 PERMISSION_DENIED` (videos)             | `generativelanguage.googleapis.com` is not enabled, or `roles/serviceusage.serviceUsageConsumer` is missing                    |
| `429`                                        | Rate limit. Retry after a while                                                                                                |
| Not shown in the menu                        | Check that the deployment was made with all three of `geminiWifAudience` / `geminiServiceAccountEmail` / `geminiProjectId` set |

## GPT Image generation / editing

GenU calls OpenAI's Images API to generate and edit images (the GPT Image family).

- Generation: `https://api.openai.com/v1/images/generations`
- Editing: `https://api.openai.com/v1/images/edits`

Authentication uses an OpenAI **API key**.

```
Frontend ──(direct invoke with IAM auth)──▶ invokeGptImage Lambda
        │ OPENAI_API_KEY (environment variable)
        ▼
    api.openai.com (Images API)
```

Results are stored in the existing `fileBucket` (S3) and recorded automatically as chat history (`/gpt-image`).

### Required parameters

Set the following in `context` of `packages/cdk/cdk.json` and deploy to enable the feature.

```json
{
  "context": {
    "openAiApiKey": "sk-...",
    "openAiImageModel": "gpt-image-2.6-sunburst",
    "openAiImageModels": ["gpt-image-2.6-flare", "gpt-image-2"]
  }
}
```

| Parameter           | Description                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openAiApiKey`      | OpenAI API key. **The `InvokeGptImage` Lambda is created at deploy time only when this parameter is set.** While it is unset (empty string) the Lambda is not created and the menu item is not shown |
| `openAiImageModel`  | Default image model. Default `gpt-image-2.6-sunburst` (high quality). `gpt-image-2.6-flare` is the fast variant                                                                                      |
| `openAiImageModels` | Additional models offered in the model selector of the image page (default `[]`). The Lambda only accepts the models listed here and in `openAiImageModel`                                           |

> **Handle the API key with care**: an API key written in `cdk.json` can end up committed to the repository. Do not commit the key to a public repository or one shared outside your organization. The key is also stored as an environment variable of the `InvokeGptImage` Lambda (and therefore in the CloudFormation template).

### Architecture

- **Direct Lambda invoke**: image generation can exceed the integration timeout of API Gateway (29 seconds), so the frontend invokes the `InvokeGptImage` Lambda directly with IAM auth (Cognito Identity Pool; timeout 15 minutes). The user is identified by verifying the ID token in the payload inside the Lambda
- **Storing results**: generated images are uploaded to S3 (`fileBucket`) and the response contains only S3 URLs (resolved to signed URLs on the frontend), to stay within the 6MB invoke payload limit
- **Chat history**: every generation is recorded in the chat history under the use case `/gpt-image`. Consecutive generations in one session are appended to one chat, which can be viewed at `/chat/:chatId`

### Features and limits

- **Generation**: generate images from text. Size (auto / 1024x1024 / 1536x1024 / 1024x1536), quality (auto / low / medium / high) and the number of images (1 to 4) can be chosen
- **Editing**: edit with images (up to 4 / 4MB in total) + text. Drag & drop upload is supported
- **Iterative editing**: a generated image can be added to the editing input with the "Edit this image" button. It is then passed to the Lambda as an S3 URL, which the Lambda resolves only for objects in the app's own bucket, so it does not count toward the 4MB input limit
- The 4MB total for inputs comes from the payload limit of a direct Lambda invoke (6MB; base64 inflates data by about 4/3)

### Troubleshooting (GPT Image)

| Symptom                            | Cause / fix                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY is not configured` | Deployed without `openAiApiKey`. Set it in `cdk.json` and redeploy                   |
| `OpenAI Images API error (401)`    | The API key is invalid. Check the key                                                |
| `OpenAI Images API error (429)`    | Rate limit or usage cap. Retry after a while, or check your usage on the OpenAI side |
| Not shown in the menu              | Check that the deployment was made with `openAiApiKey` set                           |

## The image generation / editing page

Gemini and GPT Image share one page (`/image-studio`, "Image Generation & Editing" in the menu). It works like the chat: results are stacked above, and the input box at the bottom is where you type the prompt, attach images, pick the model and change the settings (size, quality, aspect ratio, number of images). The model list comes from `geminiImageModel(s)` / `openAiImageModel(s)` above, Gemini first, then GPT Image. The model used last is remembered per browser.

- Attaching images (drag & drop, paste, or "Edit this image" on a result) makes the request an edit of those images
- Generations of one session are appended to one chat history entry even when the model is switched on the way (the chat's use case is that of the provider used first: `/gemini-image` or `/gpt-image`)
- `/gpt-image` and `/gemini-image` redirect to `/image-studio`

The video page (`/gemini-video`) works the same way. An attached video is edited; attached images become reference images.

The following features of the page need no additional setup.

### Image generation from a chat

Generates images based on a past chat conversation, for example to turn the conclusion of a discussion into one picture (an infographic).

**How to use it**: pick a chat with the conversation icon under the input box (select a chat); the referenced chat is shown as a chip in the input box (remove it with ×). When no image is attached, a text model decides from the conversation how many images to make and what each one shows (the planning model is chosen in the settings). When the prompt is empty, a default prompt asking to summarize the conclusion of the conversation in one image is filled in; edit it as needed and generate.

**Details**:

- The messages of the selected chat are formatted as a `user:` / `assistant:` transcript and sent to the Lambda in the `chatContext` field of the request
- The Lambda prepends the transcript to the prompt for the model call only. **Only the prompt the user typed is recorded in the chat history**, so the history is not cluttered with long text
- The transcript carries an instruction to always produce an image (never answer in text), so an image is generated even when the prompt does not say so
- A long conversation is cut to **10,000 characters, keeping the end (the conclusion)**, because of the 32,000-character prompt limit of gpt-image-1 (adjust `MAX_TRANSCRIPT_LENGTH` in `packages/web/src/utils/chatContext.ts`)
- Selecting a chat sets a landscape format automatically (Gemini: 16:9 / GPT Image: 1536x1024, the closest since it has no 16:9). It can be changed by hand
- The picker does not list the history of the image / video sessions themselves (`/gpt-image`, `/gemini-image`, ...)

### Saving all images as one PDF

Downloads every image generated in the session as a single PDF file, for example to hand out the results of several generations together.

- Use the "Save as PDF" button at the top right of the results
- One image per page; each page is sized to the image's own pixels and orientation, so there is no loss of quality
- The PDF is built in the browser ([jsPDF](https://github.com/parallax/jsPDF)); the only additional requests are for fetching the images again
