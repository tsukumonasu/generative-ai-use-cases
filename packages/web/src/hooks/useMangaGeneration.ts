// Orchestration of the manga generation — storyboard (planner
// LLM) -> character reference sheet -> one image per page. Frontend-only: it
// reuses the image Lambdas through useImageRender, one call per image, and
// records the whole manga into one '/manga' chat.
import { useCallback, useMemo, useState } from 'react';
import { GptImageSize } from 'generative-ai-use-cases';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import useChatApi from './useChatApi';
import useFileApi from './useFileApi';
import useImageRender from './useImageRender';
import { MODELS, findModelByModelId } from './useModel';
import useMangaState, {
  MangaResultImage,
  TASTE_PRESETS,
} from './useMangaState';
import { MediaModelOption } from '../utils/mediaModels';
import {
  MangaImageReference,
  MangaPagePlan,
  buildCharacterSheetPrompt,
  buildMangaPagePrompt,
  planManga,
} from '../utils/mangaPlanner';

// The character reference sheet lines the cast up side by side — landscape
const SHEET_ASPECT_RATIO = '16:9';
const SHEET_GPT_SIZE: GptImageSize = '1536x1024';

// Everything the image models generate here is PNG
const GENERATED_MEDIA_TYPE = 'image/png';

// An image attached to an image-model call. Passed as an S3 URL (resolved to
// bytes server-side) to keep the invoke payload small.
type ReferenceImage = {
  s3Url: string;
  mediaType: string;
};

type Params = {
  // The drawing model picked on the page (undefined = no image model is
  // offered: Gemini with the Lambda's default model, as before)
  imageModel: MediaModelOption | undefined;
  // The text model that writes the storyboard
  plannerModelId: string;
};

const useMangaGeneration = ({ imageModel, plannerModelId }: Params) => {
  const { t } = useTranslation();
  const {
    scenario,
    taste,
    tasteDetail,
    readingDirection,
    pageCount,
    aspectRatio,
    imageSize,
    gptSize,
    quality,
    useCharacterSheet,
    castPhotos,
    chatContext,
    plan,
    startPlan,
    characterSheet,
    setCharacterSheet,
    pages,
    addPage,
    replacePage,
    chatId,
  } = useMangaState();

  const { renderImage: renderWithProvider } = useImageRender();
  const { getFileDownloadSignedUrl } = useFileApi();
  const { predictStream } = useChatApi();

  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [regeneratingPage, setRegeneratingPage] = useState<number | null>(null);

  // Photos with a name are the ones actually cast as characters
  const namedCastPhotos = useMemo(
    () => castPhotos.filter((photo) => photo.name.trim().length > 0),
    [castPhotos]
  );

  // Photos are attached to the character sheet call as reference images
  const castPhotoImages = useMemo<ReferenceImage[]>(
    () =>
      namedCastPhotos.map((photo) => ({
        s3Url: photo.s3Url,
        mediaType: photo.mediaType,
      })),
    [namedCastPhotos]
  );

  const castPhotoReferences = useMemo<MangaImageReference[]>(
    () =>
      namedCastPhotos.map((photo) => ({
        kind: 'castPhoto',
        name: photo.name.trim(),
      })),
    [namedCastPhotos]
  );

  // What is attached to a page render, in attachment order: the character
  // sheet (or, when there is none, the cast photos themselves) anchors the
  // character design, the previous page anchors the art style
  const buildPageReferences = useCallback(
    (
      sheetS3Url: string | undefined,
      previousPageS3Url: string | undefined
    ): { images: ReferenceImage[]; references: MangaImageReference[] } => {
      const images: ReferenceImage[] = [];
      const references: MangaImageReference[] = [];
      if (sheetS3Url) {
        images.push({ s3Url: sheetS3Url, mediaType: GENERATED_MEDIA_TYPE });
        references.push({ kind: 'characterSheet' });
      } else {
        images.push(...castPhotoImages);
        references.push(...castPhotoReferences);
      }
      if (previousPageS3Url) {
        images.push({
          s3Url: previousPageS3Url,
          mediaType: GENERATED_MEDIA_TYPE,
        });
        references.push({ kind: 'previousPage' });
      }
      return { images, references };
    },
    [castPhotoImages, castPhotoReferences]
  );

  // Render one image with the selected provider. Reference images are passed
  // as S3 URLs (resolved to bytes server-side) to keep the invoke payload small.
  const renderImage = useCallback(
    async (params: {
      prompt: string;
      // Readable label recorded in the chat history instead of the prompt
      historyPrompt: string;
      referenceImages: ReferenceImage[];
      // The character sheet is landscape; story pages use the page format
      landscape: boolean;
      sessionChatId?: string;
    }): Promise<{ image: MangaResultImage; chatId?: string }> => {
      const { landscape } = params;
      const res = await renderWithProvider({
        provider: imageModel?.provider ?? 'gemini',
        modelId: imageModel?.modelId ?? '',
        prompt: params.prompt,
        historyPrompt: params.historyPrompt,
        n: 1,
        images: params.referenceImages,
        gpt: { size: landscape ? SHEET_GPT_SIZE : gptSize, quality },
        gemini: {
          aspectRatio: landscape ? SHEET_ASPECT_RATIO : aspectRatio,
          imageSize,
        },
        sessionChatId: params.sessionChatId,
        usecase: '/manga',
      });

      const s3Url = res.s3Urls[0];
      if (!s3Url) {
        throw new Error('The image generation API returned no image');
      }
      return {
        image: { s3Url, signedUrl: await getFileDownloadSignedUrl(s3Url) },
        chatId: res.chatId,
      };
    },
    [
      imageModel,
      aspectRatio,
      imageSize,
      gptSize,
      quality,
      renderWithProvider,
      getFileDownloadSignedUrl,
    ]
  );

  const generate = useCallback(async () => {
    setIsRunning(true);
    try {
      const preset = TASTE_PRESETS.find((p) => p.value === taste);
      const style = [
        preset?.style ?? '',
        tasteDetail.trim()
          ? `Additional style requests from the user: ${tasteDetail.trim()}`
          : '',
      ]
        .filter(Boolean)
        .join('. ');

      setStatus(t('manga.status.planning'));
      const newPlan = await planManga(
        predictStream,
        findModelByModelId(plannerModelId),
        {
          scenario,
          framedTranscript: chatContext?.transcript,
          style,
          pageCount: pageCount === 'auto' ? undefined : Number(pageCount),
          readingDirection,
          // Only a vision-capable model can read the photos
          castPhotos: MODELS.visionModelIds.includes(plannerModelId)
            ? namedCastPhotos.map((photo) => ({
                name: photo.name.trim(),
                note: photo.note.trim() || undefined,
                data: photo.data,
                mediaType: photo.mediaType,
              }))
            : [],
        }
      );
      startPlan(newPlan);

      // The session chat is threaded through the sequential invokes (the
      // store only updates after this callback yields)
      let sessionChatId: string | undefined = undefined;
      let sheetS3Url: string | undefined;

      if (useCharacterSheet && newPlan.characters.length > 0) {
        setStatus(t('manga.status.characterSheet'));
        // The cast photos are attached here, so the likeness is baked into
        // the sheet and inherited by every page through it
        const res = await renderImage({
          prompt: buildCharacterSheetPrompt(newPlan, castPhotoReferences),
          historyPrompt: t('manga.history.characterSheet', {
            title: newPlan.title,
          }),
          referenceImages: castPhotoImages,
          landscape: true,
          sessionChatId,
        });
        sessionChatId = res.chatId ?? sessionChatId;
        sheetS3Url = res.image.s3Url;
        setCharacterSheet(res.image, res.chatId);
      }

      let previousPageS3Url: string | undefined;
      for (const page of newPlan.pages) {
        setStatus(
          t('manga.status.page', {
            current: page.pageNumber,
            total: newPlan.pages.length,
          })
        );
        // Character sheet (or the cast photos) + previous page keep the cast
        // and the art consistent as the story progresses
        const { images: referenceImages, references } = buildPageReferences(
          sheetS3Url,
          previousPageS3Url
        );
        const prompt = buildMangaPagePrompt(newPlan, page, {
          readingDirection,
          references,
        });
        const res = await renderImage({
          prompt,
          historyPrompt: t('manga.history.page', {
            title: newPlan.title,
            page: page.pageNumber,
            summary: page.summary,
          }),
          referenceImages,
          landscape: false,
          sessionChatId,
        });
        sessionChatId = res.chatId ?? sessionChatId;
        previousPageS3Url = res.image.s3Url;
        addPage(
          {
            pageNumber: page.pageNumber,
            summary: page.summary,
            prompt,
            image: res.image,
          },
          res.chatId
        );
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : `${e}`;
      toast.error(t('manga.error.generationFailed', { error: message }), {
        duration: 30000,
        closeButton: true,
      });
    }
    setStatus('');
    setIsRunning(false);
  }, [
    taste,
    tasteDetail,
    scenario,
    chatContext,
    pageCount,
    readingDirection,
    plannerModelId,
    useCharacterSheet,
    namedCastPhotos,
    castPhotoImages,
    castPhotoReferences,
    buildPageReferences,
    predictStream,
    renderImage,
    startPlan,
    setCharacterSheet,
    addPage,
    t,
  ]);

  // Redraw a single page with the same references (manga output quality
  // varies a lot between runs)
  const regeneratePage = useCallback(
    async (pagePlan: MangaPagePlan) => {
      if (!plan) return;
      setRegeneratingPage(pagePlan.pageNumber);
      try {
        const previous = pages.find(
          (p) => p.pageNumber === pagePlan.pageNumber - 1
        );
        const { images: referenceImages, references } = buildPageReferences(
          characterSheet?.s3Url,
          previous?.image.s3Url
        );
        const prompt = buildMangaPagePrompt(plan, pagePlan, {
          readingDirection,
          references,
        });
        const res = await renderImage({
          prompt,
          historyPrompt: t('manga.history.page', {
            title: plan.title,
            page: pagePlan.pageNumber,
            summary: pagePlan.summary,
          }),
          referenceImages,
          landscape: false,
          sessionChatId: chatId,
        });
        replacePage({
          pageNumber: pagePlan.pageNumber,
          summary: pagePlan.summary,
          prompt,
          image: res.image,
        });
      } catch (e) {
        console.error(e);
        const message = e instanceof Error ? e.message : `${e}`;
        toast.error(t('manga.error.generationFailed', { error: message }), {
          duration: 30000,
          closeButton: true,
        });
      }
      setRegeneratingPage(null);
    },
    [
      plan,
      pages,
      characterSheet,
      readingDirection,
      chatId,
      buildPageReferences,
      renderImage,
      replacePage,
      t,
    ]
  );

  return { isRunning, status, regeneratingPage, generate, regeneratePage };
};

export default useMangaGeneration;
