# Manga Generation

## What it does

Generates a manga of several pages, complete with panel layout, speech bubbles and dialogue, from a scenario or instructions you write, or from a past chat conversation. Open it from "Manga Generation" (`/manga`) in the menu.

Generation runs in three steps.

1. **Storyboard**: the "AI Model for Storyboarding" (a Bedrock model, the same list as the chat) decides the title, the art style, how each character looks, and the panel layout and dialogue of every page.
2. **Character reference sheet**: one reference image with the whole cast side by side (can be turned on or off).
3. **Pages**: each page is generated in turn as one image. The panel borders, the speech bubbles and the lettering are all drawn by the image model.

So that the characters keep the same look from page to page, each page is generated with the character sheet and the previous page attached as reference images.

## Usage

### Input

| Field                         | Description                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenario & Instructions       | Write the plot, the characters, the direction of the punchline, the taste you want, and so on                                                                       |
| Select chat history           | Uses a past chat conversation as the source of the scenario. Can be combined with the scenario field (for a long conversation, the last 10,000 characters are used) |
| Photos of the cast (optional) | People in the photos appear as characters. Up to 6 photos (PNG / JPEG / WebP). A name is required for each photo; you can add a note on role or personality         |
| Taste                         | Shonen manga, shojo manga, seinen / gekiga, 4-koma gag, anime (colour), American comic, chibi / deformed, watercolour picture book. Extra instructions can be added |
| Reading Direction             | Right to left (Japanese manga, default) / left to right (Western comic)                                                                                             |
| Number of Pages               | Auto (the AI decides from the scenario, up to 16 pages; default) / 1 to 16 pages. A page has at most 8 panels                                                       |
| Character reference sheet     | On by default. Costs one more image but keeps the characters consistent. Recommended when you use photos                                                            |

### Choosing the models

Pick two models below the input field. Both are remembered per browser.

- **Drawing model**: chosen from the same list as "Image Generation & Editing" (Gemini and GPT Image). The settings depend on the model.
  - Gemini: page aspect ratio (default 3:4) and resolution (default 1K)
  - GPT Image: page size (default 1024x1536) and quality (default low)
- **AI Model for Storyboarding**: when photos are attached, only models that accept images can be selected, since the planner has to look at the photos.

The default resolution and quality are the lowest, to keep the PDF small and the generation fast. For more readable dialogue, choose 2K or higher with Gemini, or a higher quality with GPT Image (the files get larger and generation takes longer).

### After generation

- **Regenerate this page**: redraws one page only.
- **Download**: saves the image of a page.
- **Save as PDF**: bundles every page into one PDF (one image per page).
- **View in chat history**: one generation is recorded as one chat (usecase `/manga`). The history keeps a short description such as "Title P3: summary" instead of the long instruction sent to the model.

The result stays when you move to another page. "Clear" removes it.

## How photos are handled

- Photos are downscaled in the browser to a JPEG whose longer edge is 1024px before they are sent anywhere.
- In the storyboard step, the planner model looks at the photos and describes each character's appearance in text.
- In the drawing step, the photos are attached as reference images **to the character sheet**. Every page inherits the likeness through the sheet. With the character sheet turned off, the photos are attached to each page directly.
- The image model is told that a photo is a photo: redraw the likeness, never paste or trace it.
- Photos are stored in GenU's file S3 bucket and are handled like any other uploaded file. **Only use photos of people who have agreed to it.**

## Enabling

There is no setting of its own. The menu item appears **when either GPT Image or Gemini is enabled** ([setup](./DEPLOY_GEMINI_GPT_IMAGE.md)). The list of image models also comes from those settings (`openAiImageModel(s)` / `geminiImageModel(s)`).

No new Lambda function or AWS resource is added. The existing `InvokeGemini` / `InvokeGptImage` Lambdas are called once per image.

## Limits and notes

- **Time**: a few minutes to over ten minutes depending on the page count. The browser drives the generation page by page, so **keep the tab open while it runs** (closing it stops there; pages already generated stay in the chat history).
- **Cost**: one storyboard call + one character sheet + one image per page. 16 pages means 17 images.
- **Lettering**: dialogue is drawn by the image model too, so long lines or small text can be garbled. Raise the resolution or regenerate that page.
- **Drift**: even with the character sheet and the previous page attached, clothes or hair can change slightly as the pages go on.
- **GPT Image**: pages with reference images are generated with the edit API.
- **Opening from the history**: a chat opened from the history list shows the regular chat screen (`/chat/:chatId`). The images can be viewed, but generation cannot be continued or regenerated there.

## Where it is implemented

| Role                                  | Files                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Page                                  | `packages/web/src/pages/GenerateMangaPage.tsx`                                                                                     |
| Input and result state                | `packages/web/src/hooks/useMangaState.ts` (zustand; the taste list and the photo limit)                                            |
| Generation flow                       | `packages/web/src/hooks/useMangaGeneration.ts` (storyboard → character sheet → pages, regeneration)                                |
| Photo panel                           | `packages/web/src/components/manga/MangaCastPhotoPanel.tsx`, `utils/imageDownscale.ts`                                             |
| Storyboard prompt and drawing prompts | `packages/web/src/utils/mangaPlanner.ts` (`planManga`, `buildCharacterSheetPrompt`, `buildMangaPagePrompt`, page and panel limits) |
| Image generation calls                | `packages/web/src/hooks/useImageRender.ts` (GPT / Gemini dispatch), `utils/invokeMediaLambda.ts`                                   |
| Download / PDF                        | `packages/web/src/hooks/useMediaDownload.ts`, `utils/exportImagesPdf.ts`                                                           |
| Chat selection                        | `packages/web/src/components/ModalDialogSelectChat.tsx`, `utils/chatContext.ts`                                                    |
| Lambdas (shared with the image page)  | `packages/cdk/lambda/invokeGemini.ts`, `invokeGptImage.ts`, `lambda/utils/mediaHistory.ts` (`usecase` and `historyPrompt`)         |
| Menu and route                        | `packages/web/src/App.tsx`, `main.tsx` (shown when `geminiEnabled \|\| gptImageEnabled`)                                           |
