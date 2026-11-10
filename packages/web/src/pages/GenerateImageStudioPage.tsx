// Image generation / editing with GPT Image (OpenAI Images API)
// and Gemini (Nano Banana, Vertex AI) on one page. It is laid out like the
// chat page: the session's exchanges in the middle and the input box at the
// bottom, where the image model is picked like the chat's model. Attaching
// images (or "edit this image" on a result) edits them; otherwise the prompt
// generates new ones. Referencing a chat lets a text model plan the images.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import {
  GeminiImageSize,
  GeminiImageThinkingLevel,
  GptImageBackground,
  GptImageOutputFormat,
  GptImageQuality,
  GptImageSize,
} from 'generative-ai-use-cases';
import {
  DEFAULT_GPT_IMAGE_GIF_FRAMES,
  DEFAULT_GPT_IMAGE_GIF_FRAME_DURATION_MS,
  GPT_IMAGE_BACKGROUNDS,
  GPT_IMAGE_GIF_FRAME_DURATIONS_MS,
  GPT_IMAGE_GIF_MAX_FRAMES,
  GPT_IMAGE_GIF_MIN_FRAMES,
  geminiImageAspectRatios,
  geminiImageThinkingLevels,
  gptImageHasCompression,
  gptImageOutputFormats,
  gptImageQualities,
  gptImageSizes,
} from '@generative-ai-use-cases/common';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  PiArrowClockwise,
  PiChatsCircle,
  PiDownload,
  PiFilePdf,
  PiImages,
  PiPencilSimple,
} from 'react-icons/pi';
import useImageRender, { ImageRenderInput } from '../hooks/useImageRender';
import useMediaDownload from '../hooks/useMediaDownload';
import useFileApi from '../hooks/useFileApi';
import useChatApi from '../hooks/useChatApi';
import { MODELS, findModelByModelId } from '../hooks/useModel';
import useModelPreference, {
  useTextModelOptions,
} from '../hooks/useModelPreference';
import InputChatContent from '../components/InputChatContent';
import ButtonIcon from '../components/ButtonIcon';
import Button from '../components/Button';
import ModalDialog from '../components/ModalDialog';
import ZoomUpImage from '../components/ZoomUpImage';
import ModalDialogSelectChat from '../components/ModalDialogSelectChat';
import {
  InputChip,
  InputToolbarButton,
  MediaAttachButton,
  MediaExchange,
  MediaGenerating,
  MediaSessionLayout,
} from '../components/MediaSession';
import {
  MediaSettingField,
  MediaSettingsBar,
  MediaSettingsForm,
} from '../components/MediaSettings';
import useValidMediaSettings from '../hooks/useValidMediaSettings';
import { ImageChatContext } from '../utils/chatContext';
import { planImagePrompts, MAX_PLANNED_IMAGES } from '../utils/imagePlanner';
import { exportImagesToPdf } from '../utils/exportImagesPdf';
import {
  IMAGE_MODELS,
  MediaModelOption,
  findMediaModel,
  geminiImageSizes,
} from '../utils/mediaModels';

const NUMBER_OPTIONS = [1, 2, 3, 4];
// JPEG / WebP compression levels offered (100 = best quality, largest file)
const COMPRESSION_OPTIONS = [100, 90, 80, 60, 40];
// "Leave it to the model" for the thinking level
const THINKING_DEFAULT = 'default';
const GIF_FRAME_OPTIONS = Array.from(
  { length: GPT_IMAGE_GIF_MAX_FRAMES - GPT_IMAGE_GIF_MIN_FRAMES + 1 },
  (_, i) => GPT_IMAGE_GIF_MIN_FRAMES + i
);

// File extension of a generated image, from its S3 URL (PNG unless another
// output format was picked)
const extensionOf = (s3Url: string): string =>
  s3Url.match(/\.(png|jpg|jpeg|webp|gif)(?:$|\?)/i)?.[1].toLowerCase() ?? 'png';
const MAX_INPUT_IMAGES = 4;
// Keep the direct-invoke payload within the Lambda limit (6MB);
// base64 encoding inflates the raw size by ~4/3
const MAX_TOTAL_INPUT_SIZE = 4 * 1024 * 1024;
const ACCEPT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

type InputImage = {
  // URL used for the thumbnail (data URI or object URL — never expires)
  previewUrl: string;
  mediaType: string;
  // Raw size counted toward the payload cap (0 for s3-backed images)
  size: number;
  // Exactly one of the following is set:
  dataUrl?: string; // local upload (data URI, sent as base64)
  s3Url?: string; // reused generated image (sent as S3 URL, resolved server-side)
};

type ResultImage = {
  // Permanent S3 URL (used to issue a fresh signed URL on download,
  // since signed URLs expire after 60 seconds)
  s3Url: string;
  // Signed URL issued right after generation (used for display)
  signedUrl: string;
};

// One prompt -> result round trip of the interactive session, recorded as
// one user/assistant message pair of the session's chat
type Exchange = {
  prompt: string;
  modelLabel: string;
  results: ResultImage[];
};

type StateType = {
  prompt: string;
  // GPT Image settings
  gptSize: GptImageSize;
  gptQuality: GptImageQuality;
  gptBackground: GptImageBackground;
  gptOutputFormat: GptImageOutputFormat;
  // 0-100, JPEG / WebP only
  gptCompression: number;
  // GIF animation only
  gifFrames: number;
  gifFrameDurationMs: number;
  // Gemini settings
  aspectRatio: string;
  imageSize: GeminiImageSize;
  thinkingLevel: GeminiImageThinkingLevel | typeof THINKING_DEFAULT;
  n: number;
  inputImages: InputImage[];
  exchanges: Exchange[];
  // Chat the ongoing session is recorded into (all exchanges until clear)
  chatId?: string;
  // Existing chat referenced as context (to summarize its conclusion)
  chatContext?: ImageChatContext;
  setPrompt: (s: string) => void;
  setGptSize: (s: GptImageSize) => void;
  setGptQuality: (q: GptImageQuality) => void;
  setGptBackground: (b: GptImageBackground) => void;
  setGptOutputFormat: (f: GptImageOutputFormat) => void;
  setGptCompression: (c: number) => void;
  setGifFrames: (n: number) => void;
  setGifFrameDurationMs: (ms: number) => void;
  setAspectRatio: (s: string) => void;
  setImageSize: (s: GeminiImageSize) => void;
  setThinkingLevel: (l: StateType['thinkingLevel']) => void;
  setN: (n: number) => void;
  setChatContext: (c?: ImageChatContext) => void;
  addInputImages: (images: InputImage[]) => void;
  removeInputImage: (index: number) => void;
  clearInputImages: () => void;
  addExchange: (exchange: Exchange, chatId?: string) => void;
  setExchanges: (exchanges: Exchange[]) => void;
  clear: () => void;
};

const useImageStudioState = create<StateType>((set) => {
  const INIT_SETTINGS = {
    gptSize: 'auto' as GptImageSize,
    // Lowest quality / resolution by default — the session can be bundled
    // into one PDF, and large images make that file huge
    gptQuality: 'low' as GptImageQuality,
    gptBackground: 'auto' as GptImageBackground,
    gptOutputFormat: 'png' as GptImageOutputFormat,
    gptCompression: 100,
    gifFrames: DEFAULT_GPT_IMAGE_GIF_FRAMES,
    gifFrameDurationMs: DEFAULT_GPT_IMAGE_GIF_FRAME_DURATION_MS,
    aspectRatio: '1:1',
    imageSize: '1K' as GeminiImageSize,
    thinkingLevel: THINKING_DEFAULT as StateType['thinkingLevel'],
    n: 1,
  };
  const INIT_SESSION = {
    prompt: '',
    inputImages: [],
    exchanges: [],
    chatId: undefined,
    chatContext: undefined,
  };
  return {
    ...INIT_SETTINGS,
    ...INIT_SESSION,
    setPrompt: (s) => set(() => ({ prompt: s })),
    setGptSize: (s) => set(() => ({ gptSize: s })),
    setGptQuality: (q) => set(() => ({ gptQuality: q })),
    setGptBackground: (b) => set(() => ({ gptBackground: b })),
    setGptOutputFormat: (f) => set(() => ({ gptOutputFormat: f })),
    setGptCompression: (c) => set(() => ({ gptCompression: c })),
    setGifFrames: (n) => set(() => ({ gifFrames: n })),
    setGifFrameDurationMs: (ms) => set(() => ({ gifFrameDurationMs: ms })),
    setAspectRatio: (s) => set(() => ({ aspectRatio: s })),
    setImageSize: (s) => set(() => ({ imageSize: s })),
    setThinkingLevel: (l) => set(() => ({ thinkingLevel: l })),
    setN: (n) => set(() => ({ n })),
    setChatContext: (c) => set(() => ({ chatContext: c })),
    addInputImages: (images) =>
      set((state) => ({
        inputImages: [...state.inputImages, ...images].slice(
          0,
          MAX_INPUT_IMAGES
        ),
      })),
    removeInputImage: (index) =>
      set((state) => ({
        inputImages: state.inputImages.filter((_, i) => i !== index),
      })),
    clearInputImages: () => set(() => ({ inputImages: [] })),
    addExchange: (exchange, chatId) =>
      set((state) => ({
        exchanges: [...state.exchanges, exchange],
        // Keep the session chat even if recording failed for one round
        chatId: chatId ?? state.chatId,
      })),
    setExchanges: (exchanges) => set(() => ({ exchanges })),
    // Starting over keeps the settings the user picked
    clear: () => set(INIT_SESSION),
  };
});

const toInputMedia = (image: InputImage): ImageRenderInput => {
  if (image.s3Url) {
    return { s3Url: image.s3Url, mediaType: image.mediaType };
  }
  return {
    data: image.dataUrl!.split(',')[1],
    mediaType: image.mediaType,
  };
};

const readAsInputImage = (file: File): Promise<InputImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        previewUrl: reader.result as string,
        dataUrl: reader.result as string,
        mediaType: file.type,
        size: file.size,
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const GenerateImageStudioPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    prompt,
    setPrompt,
    gptSize,
    setGptSize,
    gptQuality,
    setGptQuality,
    gptBackground,
    setGptBackground,
    gptOutputFormat,
    setGptOutputFormat,
    gptCompression,
    setGptCompression,
    gifFrames,
    setGifFrames,
    gifFrameDurationMs,
    setGifFrameDurationMs,
    aspectRatio,
    setAspectRatio,
    imageSize,
    setImageSize,
    thinkingLevel,
    setThinkingLevel,
    n,
    setN,
    inputImages,
    addInputImages,
    removeInputImage,
    clearInputImages,
    exchanges,
    chatId,
    chatContext,
    setChatContext,
    addExchange,
    setExchanges,
    clear,
  } = useImageStudioState();
  const { renderImage } = useImageRender();
  const { fetchBlob, download } = useMediaDownload();
  const { getFileDownloadSignedUrl } = useFileApi();
  const { predictStream } = useChatApi();

  // The image model and the planner model are remembered like the chat's
  const [modelValue, setModelValue] = useModelPreference(
    'imageStudioModel',
    IMAGE_MODELS.map((m) => m.value)
  );
  const model: MediaModelOption | undefined = findMediaModel(
    IMAGE_MODELS,
    modelValue
  );
  const [plannerModelId, setPlannerModelId] = useModelPreference(
    'imagePlannerModelId',
    MODELS.modelIds
  );
  const plannerOptions = useTextModelOptions(MODELS.modelIds);

  const [isGenerating, setIsGenerating] = useState(false);
  // Progress text shown in the timeline while auto-plan generation runs
  const [genStatus, setGenStatus] = useState('');
  const [isSelectChatOpen, setIsSelectChatOpen] = useState(false);
  const [isSettingOpen, setIsSettingOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

  const isEdit = inputImages.length > 0;
  // A referenced chat without images to edit: a text model plans the set
  const autoPlan = !isEdit && !!chatContext;

  // The settings of the selected model. What a model offers comes from the
  // table shared with the Lambdas (packages/common, mediaParams.ts).
  const settingFields: MediaSettingField[] = useMemo(() => {
    if (!model) return [];
    const autoLabel = t('imageStudio.auto');
    const fields: MediaSettingField[] = [];

    if (model.provider === 'gpt') {
      fields.push(
        {
          key: 'gptSize',
          label: t('imageStudio.size'),
          value: gptSize,
          onChange: (v) => setGptSize(v as GptImageSize),
          options: gptImageSizes(model.modelId).map((v) => ({
            value: v,
            label: v === 'auto' ? autoLabel : v,
          })),
          primary: true,
        },
        {
          key: 'gptQuality',
          label: t('imageStudio.quality'),
          value: gptQuality,
          onChange: (v) => setGptQuality(v as GptImageQuality),
          options: gptImageQualities(model.modelId).map((v) => ({
            value: v,
            label: v === 'auto' ? autoLabel : t(`imageStudio.qualities.${v}`),
          })),
          primary: true,
        }
      );
    } else {
      const thinkingLevels = geminiImageThinkingLevels(model.modelId);
      fields.push(
        {
          key: 'aspectRatio',
          label: t('imageStudio.aspectRatio'),
          value: aspectRatio,
          onChange: setAspectRatio,
          options: geminiImageAspectRatios(model.modelId).map((v) => ({
            value: v,
            label: v,
          })),
          primary: true,
        },
        {
          key: 'imageSize',
          label: t('imageStudio.imageSize'),
          value: imageSize,
          onChange: (v) => setImageSize(v as GeminiImageSize),
          options: geminiImageSizes(model.modelId).map((v) => ({
            value: v,
            label: v,
          })),
          primary: true,
        },
        ...(thinkingLevels.length > 0
          ? [
              {
                key: 'thinkingLevel',
                label: t('imageStudio.thinkingLevel'),
                value: thinkingLevel,
                onChange: (v: string) =>
                  setThinkingLevel(v as StateType['thinkingLevel']),
                options: [THINKING_DEFAULT, ...thinkingLevels].map((v) => ({
                  value: v,
                  label: t(`imageStudio.thinkingLevels.${v}`),
                })),
                help: t('imageStudio.thinkingLevelHelp'),
              },
            ]
          : [])
      );
    }

    // With a referenced chat the planner decides the number of images
    if (!autoPlan) {
      fields.push({
        key: 'n',
        label: t('imageStudio.numberOfImages'),
        value: `${n}`,
        onChange: (v) => setN(Number(v)),
        options: NUMBER_OPTIONS.map((v) => ({ value: `${v}`, label: `${v}` })),
        primary: true,
      });
    }

    if (model.provider === 'gpt') {
      fields.push(
        {
          key: 'gptBackground',
          label: t('imageStudio.background'),
          value: gptBackground,
          onChange: (v) => setGptBackground(v as GptImageBackground),
          options: GPT_IMAGE_BACKGROUNDS.map((v) => ({
            value: v,
            label: v === 'auto' ? autoLabel : t(`imageStudio.backgrounds.${v}`),
          })),
          help: t('imageStudio.backgroundHelp'),
        },
        {
          key: 'gptOutputFormat',
          label: t('imageStudio.outputFormat'),
          value: gptOutputFormat,
          onChange: (v) => setGptOutputFormat(v as GptImageOutputFormat),
          options: gptImageOutputFormats(gptBackground).map((v) => ({
            value: v,
            label: t(`imageStudio.outputFormats.${v}`),
          })),
          // The format decides whether the result is a still or an animation
          primary: true,
          help: t('imageStudio.outputFormatHelp'),
        }
      );
      if (gptImageHasCompression(gptOutputFormat)) {
        fields.push({
          key: 'gptCompression',
          label: t('imageStudio.compression'),
          value: `${gptCompression}`,
          onChange: (v) => setGptCompression(Number(v)),
          options: COMPRESSION_OPTIONS.map((v) => ({
            value: `${v}`,
            label: `${v}%`,
          })),
          help: t('imageStudio.compressionHelp'),
        });
      }
      if (gptOutputFormat === 'gif') {
        fields.push(
          {
            key: 'gifFrames',
            label: t('imageStudio.gifFrames'),
            value: `${gifFrames}`,
            onChange: (v) => setGifFrames(Number(v)),
            options: GIF_FRAME_OPTIONS.map((v) => ({
              value: `${v}`,
              label: `${v}`,
            })),
            fallback: `${DEFAULT_GPT_IMAGE_GIF_FRAMES}`,
            primary: true,
          },
          {
            key: 'gifFrameDurationMs',
            label: t('imageStudio.gifFrameDuration'),
            value: `${gifFrameDurationMs}`,
            onChange: (v) => setGifFrameDurationMs(Number(v)),
            options: GPT_IMAGE_GIF_FRAME_DURATIONS_MS.map((v) => ({
              value: `${v}`,
              label: t('imageStudio.seconds', { n: v / 1000 }),
            })),
            fallback: `${DEFAULT_GPT_IMAGE_GIF_FRAME_DURATION_MS}`,
            primary: true,
            help: t('imageStudio.gifHelp'),
          }
        );
      }
    }

    if (autoPlan) {
      // The text model that decides the images and their prompts
      fields.push({
        key: 'plannerModel',
        label: t('imageAutoPlan.model'),
        value: plannerModelId,
        onChange: setPlannerModelId,
        options: plannerOptions,
      });
    }
    return fields;
  }, [
    model,
    autoPlan,
    gptSize,
    gptQuality,
    gptBackground,
    gptOutputFormat,
    gptCompression,
    gifFrames,
    gifFrameDurationMs,
    aspectRatio,
    imageSize,
    thinkingLevel,
    n,
    plannerModelId,
    plannerOptions,
    setGptSize,
    setGptQuality,
    setGptBackground,
    setGptOutputFormat,
    setGptCompression,
    setGifFrames,
    setGifFrameDurationMs,
    setAspectRatio,
    setImageSize,
    setThinkingLevel,
    setN,
    setPlannerModelId,
    t,
  ]);
  useValidMediaSettings(settingFields);

  // The settings an exchange was made with, shown beside its model
  const settingSummary = useMemo(
    () =>
      settingFields
        .filter((f) => f.primary && f.key !== 'n')
        .map((f) => f.options.find((o) => o.value === f.value)?.label ?? '')
        .filter((label) => label)
        .join(' · '),
    [settingFields]
  );

  // Results persist in the store across navigation, but signed URLs expire
  // after 60 seconds — re-issue them when the page mounts
  useEffect(() => {
    if (exchanges.length === 0) return;
    Promise.all(
      exchanges.map(async (exchange) => ({
        ...exchange,
        results: await Promise.all(
          exchange.results.map(async (image) => ({
            s3Url: image.s3Url,
            signedUrl: await getFileDownloadSignedUrl(image.s3Url),
          }))
        ),
      }))
    ).then(setExchanges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the latest exchange (or the generating indicator) in view,
  // like a chat timeline
  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [exchanges.length, isGenerating]);

  const addFiles = useCallback(
    (files: File[]) => {
      let total = inputImages.reduce((sum, i) => sum + i.size, 0);
      const accepted: File[] = [];

      for (const file of files) {
        if (!ACCEPT_MEDIA_TYPES.includes(file.type)) {
          toast.error(t('imageStudio.error.unsupportedFileType'));
          continue;
        }
        if (inputImages.length + accepted.length >= MAX_INPUT_IMAGES) {
          toast.error(
            t('imageStudio.error.tooManyImages', { max: MAX_INPUT_IMAGES })
          );
          break;
        }
        if (total + file.size > MAX_TOTAL_INPUT_SIZE) {
          toast.error(t('imageStudio.error.fileTooLarge'));
          continue;
        }
        total += file.size;
        accepted.push(file);
      }

      Promise.all(accepted.map(readAsInputImage)).then(addInputImages);
    },
    [inputImages, addInputImages, t]
  );

  // Use a generated image as an edit source for further editing
  const addResultToInputs = useCallback(
    async (image: ResultImage) => {
      if (inputImages.length >= MAX_INPUT_IMAGES) {
        toast.error(
          t('imageStudio.error.tooManyImages', { max: MAX_INPUT_IMAGES })
        );
        return;
      }
      try {
        // Fetch a non-expiring thumbnail (object URL); the request itself
        // sends only the S3 URL, which is resolved server-side
        const blob = await fetchBlob(image.s3Url);
        addInputImages([
          {
            previewUrl: URL.createObjectURL(blob),
            s3Url: image.s3Url,
            mediaType: blob.type || 'image/png',
            size: 0,
          },
        ]);
      } catch (e) {
        console.error(e);
        toast.error(t('imageStudio.error.downloadFailed'));
      }
    },
    [inputImages, addInputImages, fetchBlob, t]
  );

  // Reference an existing chat: its transcript is sent along with the
  // prompt so the images can summarize the conversation's conclusion
  const onSelectChatContext = useCallback(
    (context: ImageChatContext) => {
      setChatContext(context);
      if (prompt.length === 0) {
        setPrompt(t('imageChatContext.defaultPrompt'));
      }
      // Summary slides read best in landscape (GPT Image has no 16:9, so it
      // gets the closest landscape size)
      setAspectRatio('16:9');
      setGptSize('1536x1024');
    },
    [setChatContext, prompt, setPrompt, setAspectRatio, setGptSize, t]
  );

  // One call to the selected model with the page's settings; resolves to the
  // S3 URLs of the images
  const render = useCallback(
    (
      selected: MediaModelOption,
      req: { prompt: string; n: number; images?: InputImage[] },
      sessionChatId?: string
    ) =>
      renderImage({
        provider: selected.provider,
        modelId: selected.modelId,
        prompt: req.prompt,
        chatContext: chatContext?.transcript,
        n: req.n,
        images: req.images?.map(toInputMedia),
        gpt: {
          size: gptSize,
          quality: gptQuality,
          background: gptBackground,
          outputFormat: gptOutputFormat,
          outputCompression: gptCompression,
          frameCount: gifFrames,
          frameDurationMs: gifFrameDurationMs,
        },
        gemini: {
          aspectRatio,
          imageSize,
          ...(thinkingLevel !== THINKING_DEFAULT ? { thinkingLevel } : {}),
        },
        sessionChatId,
      }),
    [
      chatContext,
      gptSize,
      gptQuality,
      gptBackground,
      gptOutputFormat,
      gptCompression,
      gifFrames,
      gifFrameDurationMs,
      aspectRatio,
      imageSize,
      thinkingLevel,
      renderImage,
    ]
  );

  const toResults = useCallback(
    (s3Urls: string[]) =>
      Promise.all(
        s3Urls.map(async (s3Url) => ({
          s3Url,
          signedUrl: await getFileDownloadSignedUrl(s3Url),
        }))
      ),
    [getFileDownloadSignedUrl]
  );

  const generate = useCallback(async () => {
    // Enter in the input box also lands here while a generation runs
    if (!model || isGenerating) return;
    setIsGenerating(true);
    try {
      if (autoPlan && chatContext) {
        // Auto-plan: a text model reads the referenced chat and the request,
        // decides how many images to draw (up to MAX_PLANNED_IMAGES) and
        // writes one prompt per image; then generate them one by one
        setGenStatus(t('imageAutoPlan.planning'));
        const plannedPrompts = await planImagePrompts(
          predictStream,
          findModelByModelId(plannerModelId),
          chatContext.transcript,
          prompt
        );

        // Thread the session chat through the sequential invokes (the
        // store's chatId only updates after this callback finishes)
        let sessionChatId = chatId;
        for (let i = 0; i < plannedPrompts.length; i++) {
          setGenStatus(
            t('imageAutoPlan.generatingProgress', {
              current: i + 1,
              total: plannedPrompts.length,
            })
          );
          const res = await render(
            model,
            { prompt: plannedPrompts[i], n: 1 },
            sessionChatId
          );
          sessionChatId = res.chatId ?? sessionChatId;
          addExchange(
            {
              prompt: plannedPrompts[i],
              modelLabel: `${model.label} · ${settingSummary}`,
              results: await toResults(res.s3Urls),
            },
            res.chatId
          );
        }
      } else {
        const res = await render(
          model,
          { prompt, n, images: inputImages },
          chatId
        );
        addExchange(
          {
            prompt,
            modelLabel: `${model.label} · ${settingSummary}`,
            results: await toResults(res.s3Urls),
          },
          res.chatId
        );
      }
      setPrompt('');
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : `${e}`;
      toast.error(t('imageStudio.error.generationFailed', { error: message }), {
        duration: 30000,
        closeButton: true,
      });
    }
    setGenStatus('');
    setIsGenerating(false);
  }, [
    model,
    isGenerating,
    autoPlan,
    chatContext,
    predictStream,
    plannerModelId,
    prompt,
    chatId,
    n,
    inputImages,
    settingSummary,
    render,
    toResults,
    addExchange,
    setPrompt,
    t,
  ]);

  // Bundle every image of the session into a single PDF
  const exportPdf = useCallback(async () => {
    setIsExportingPdf(true);
    try {
      const s3Urls = exchanges.flatMap((exchange) =>
        exchange.results.map((image) => image.s3Url)
      );
      // A fresh signed URL is issued for every image (they expire in 60s)
      const blobs = await Promise.all(s3Urls.map(fetchBlob));
      await exportImagesToPdf(blobs, `images-${Date.now()}.pdf`);
    } catch (e) {
      console.error(e);
      toast.error(t('imagePdf.error.exportFailed'));
    }
    setIsExportingPdf(false);
  }, [exchanges, fetchBlob, t]);

  const downloadImage = useCallback(
    (image: ResultImage, index: number) =>
      download(
        image.s3Url,
        `image-${Date.now()}-${index}.${extensionOf(image.s3Url)}`,
        t('imageStudio.error.downloadFailed')
      ),
    [download, t]
  );

  const onReset = useCallback(() => {
    clear();
  }, [clear]);

  const placeholder = isEdit
    ? t('imageStudio.placeholder.edit')
    : chatContext
      ? t('imageStudio.placeholder.chat')
      : t('imageStudio.placeholder.generate');

  const topContent = (chatContext || inputImages.length > 0) && (
    <div className="flex flex-wrap items-center gap-2 p-2">
      {chatContext && (
        <InputChip
          icon={<PiChatsCircle />}
          removeLabel={t('imageChatContext.remove')}
          onRemove={() => setChatContext(undefined)}>
          {chatContext.title}{' '}
          <span className="text-gray-400">
            {t('imageChatContext.messageCount', {
              n: chatContext.messageCount,
            })}
          </span>
        </InputChip>
      )}
      {inputImages.map((image, idx) => (
        <ZoomUpImage
          key={idx}
          src={image.previewUrl}
          size="s"
          onDelete={() => removeInputImage(idx)}
        />
      ))}
    </div>
  );

  return (
    <>
      <MediaSessionLayout
        title={t('imageStudio.title')}
        description={t('imageStudio.description')}
        emptyIcon={<PiImages className="h-24 w-24" />}
        emptyText={t('imageStudio.noResults')}
        isEmpty={exchanges.length === 0 && !isGenerating}
        onDropFiles={addFiles}
        actions={
          <>
            {exchanges.length > 0 && (
              <button
                className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline disabled:opacity-50"
                disabled={isExportingPdf}
                onClick={exportPdf}>
                {isExportingPdf ? (
                  <PiArrowClockwise className="animate-spin text-base" />
                ) : (
                  <PiFilePdf className="text-base" />
                )}
                {t('imagePdf.exportAll')}
              </button>
            )}
            {chatId && (
              <Link
                className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline"
                to={`/chat/${chatId}`}>
                <PiChatsCircle className="text-base" />
                {t('imageStudio.viewInHistory')}
              </Link>
            )}
          </>
        }
        input={
          <InputChatContent
            content={prompt}
            onChangeContent={setPrompt}
            placeholder={placeholder}
            onSend={generate}
            loading={isGenerating}
            disabled={!model}
            isEmpty={exchanges.length === 0}
            onReset={onReset}
            topContent={topContent}
            bottomContent={
              <MediaSettingsBar
                fields={settingFields}
                disabled={isGenerating}
              />
            }
            onPasteFiles={addFiles}
            toolbarStart={
              <>
                <MediaAttachButton
                  accept={ACCEPT_MEDIA_TYPES}
                  hasFiles={inputImages.length > 0}
                  disabled={isGenerating}
                  onFiles={addFiles}
                />
                <InputToolbarButton
                  label={t('imageChatContext.select')}
                  icon={<PiChatsCircle />}
                  active={!!chatContext}
                  disabled={isGenerating}
                  onClick={() => setIsSelectChatOpen(true)}
                />
              </>
            }
            modelId={modelValue}
            onModelChange={setModelValue}
            modelOptions={IMAGE_MODELS}
            setting
            onSetting={() => setIsSettingOpen(true)}
          />
        }>
        {exchanges.map((exchange, exchangeIdx) => (
          <MediaExchange
            key={exchangeIdx}
            prompt={exchange.prompt}
            modelLabel={exchange.modelLabel}>
            <div
              className={`grid gap-4 ${
                exchange.results.length === 1
                  ? 'grid-cols-1'
                  : 'grid-cols-1 md:grid-cols-2'
              }`}>
              {exchange.results.map((image, idx) => (
                <div key={idx} className="relative">
                  <img
                    className="w-full rounded border object-contain"
                    src={image.signedUrl}
                  />
                  <div className="absolute right-2 top-2 flex flex-col gap-y-2">
                    <ButtonIcon
                      className="border bg-white"
                      onClick={() => downloadImage(image, idx)}
                      title={t('imageStudio.download')}>
                      <PiDownload className="text-aws-smile text-base" />
                    </ButtonIcon>
                    {/* An animation cannot be an edit source */}
                    {extensionOf(image.s3Url) !== 'gif' && (
                      <ButtonIcon
                        className="border bg-white"
                        onClick={() => addResultToInputs(image)}
                        title={t('imageStudio.editThisImage')}>
                        <PiPencilSimple className="text-aws-smile text-base" />
                      </ButtonIcon>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </MediaExchange>
        ))}
        {isGenerating && (
          <MediaGenerating text={genStatus || t('imageStudio.generating')} />
        )}
        <div ref={timelineBottomRef} />
      </MediaSessionLayout>

      <ModalDialog
        isOpen={isSettingOpen}
        onClose={() => setIsSettingOpen(false)}
        title={t('imageStudio.settings')}>
        <div className="flex flex-col gap-2">
          <MediaSettingsForm fields={settingFields} />
          {autoPlan && (
            <p className="text-xs text-gray-400">
              {t('imageAutoPlan.autoCountHelp', { max: MAX_PLANNED_IMAGES })}
            </p>
          )}

          <p className="text-xs text-gray-400">{t('imageStudio.help')}</p>

          {isEdit && (
            <button
              type="button"
              className="text-aws-smile self-start text-xs hover:underline"
              onClick={clearInputImages}>
              {t('imageStudio.clearInputImages')}
            </button>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => setIsSettingOpen(false)}>
            {t('imageStudio.settingsDone')}
          </Button>
        </div>
      </ModalDialog>

      <ModalDialogSelectChat
        isOpen={isSelectChatOpen}
        onClose={() => setIsSelectChatOpen(false)}
        onSelect={onSelectChatContext}
      />
    </>
  );
};

export default GenerateImageStudioPage;
