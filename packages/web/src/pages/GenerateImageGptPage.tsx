// Fork custom: GPT Image (OpenAI Images API) generation / editing page
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import {
  GptImageMode,
  GptImageSize,
  GptImageQuality,
  GptImageInputImage,
} from 'generative-ai-use-cases';
import useGptImageApi from '../hooks/useGptImageApi';
import useFileApi from '../hooks/useFileApi';
import Card from '../components/Card';
import Textarea from '../components/Textarea';
import Select from '../components/Select';
import Button from '../components/Button';
import ButtonIcon from '../components/ButtonIcon';
import ZoomUpImage from '../components/ZoomUpImage';
import ModalDialogSelectChat from '../components/ModalDialogSelectChat';
import { ImageChatContext } from '../utils/chatContext';
import { exportImagesToPdf } from '../utils/exportImagesPdf';
import {
  PiArrowClockwise,
  PiChatsCircle,
  PiDownload,
  PiFilePdf,
  PiImages,
  PiPencilSimple,
  PiUpload,
  PiX,
} from 'react-icons/pi';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const SIZE_OPTIONS: GptImageSize[] = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
];
const QUALITY_OPTIONS: GptImageQuality[] = ['auto', 'low', 'medium', 'high'];
const NUMBER_OPTIONS = [1, 2, 3, 4];
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

// One prompt → result round trip of the interactive session, displayed
// like a chat exchange and recorded as one user/assistant message pair
type Exchange = {
  prompt: string;
  results: ResultImage[];
};

type StateType = {
  mode: GptImageMode;
  prompt: string;
  size: GptImageSize;
  quality: GptImageQuality;
  n: number;
  inputImages: InputImage[];
  exchanges: Exchange[];
  // Chat the ongoing session is recorded into (all exchanges until clear)
  chatId?: string;
  // Existing chat referenced as context (to summarize its conclusion)
  chatContext?: ImageChatContext;
  setMode: (m: GptImageMode) => void;
  setPrompt: (s: string) => void;
  setSize: (s: GptImageSize) => void;
  setQuality: (q: GptImageQuality) => void;
  setN: (n: number) => void;
  setChatContext: (c?: ImageChatContext) => void;
  addInputImages: (images: InputImage[]) => void;
  removeInputImage: (index: number) => void;
  addExchange: (exchange: Exchange, chatId?: string) => void;
  setExchanges: (exchanges: Exchange[]) => void;
  clear: () => void;
};

const useGenerateImageGptPageState = create<StateType>((set) => {
  const INIT_STATE = {
    mode: 'generate' as GptImageMode,
    prompt: '',
    size: 'auto' as GptImageSize,
    quality: 'auto' as GptImageQuality,
    n: 1,
    inputImages: [],
    exchanges: [],
    chatId: undefined,
    chatContext: undefined,
  };
  return {
    ...INIT_STATE,
    setMode: (m) => set(() => ({ mode: m })),
    setPrompt: (s) => set(() => ({ prompt: s })),
    setSize: (s) => set(() => ({ size: s })),
    setQuality: (q) => set(() => ({ quality: q })),
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
    addExchange: (exchange, chatId) =>
      set((state) => ({
        exchanges: [...state.exchanges, exchange],
        // Keep the session chat even if recording failed for one round
        chatId: chatId ?? state.chatId,
      })),
    setExchanges: (exchanges) => set(() => ({ exchanges })),
    clear: () => set(INIT_STATE),
  };
});

const toInputImage = (image: InputImage): GptImageInputImage => {
  if (image.s3Url) {
    return { s3Url: image.s3Url, mediaType: image.mediaType };
  }
  return {
    data: image.dataUrl!.split(',')[1],
    mediaType: image.mediaType,
  };
};

const GenerateImageGptPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    mode,
    setMode,
    prompt,
    setPrompt,
    size,
    setSize,
    quality,
    setQuality,
    n,
    setN,
    inputImages,
    addInputImages,
    removeInputImage,
    exchanges,
    chatId,
    chatContext,
    setChatContext,
    addExchange,
    setExchanges,
    clear,
  } = useGenerateImageGptPageState();
  const { generateImage, editImage } = useGptImageApi();
  const { getFileDownloadSignedUrl } = useFileApi();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSelectChatOpen, setIsSelectChatOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

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
      const currentTotal = inputImages.reduce((sum, i) => sum + i.size, 0);
      let total = currentTotal;
      const accepted: File[] = [];

      for (const file of files) {
        if (!ACCEPT_MEDIA_TYPES.includes(file.type)) {
          toast.error(t('gptImage.error.unsupportedFileType'));
          continue;
        }
        if (inputImages.length + accepted.length >= MAX_INPUT_IMAGES) {
          toast.error(
            t('gptImage.error.tooManyImages', { max: MAX_INPUT_IMAGES })
          );
          break;
        }
        if (total + file.size > MAX_TOTAL_INPUT_SIZE) {
          toast.error(t('gptImage.error.fileTooLarge'));
          continue;
        }
        total += file.size;
        accepted.push(file);
      }

      Promise.all(
        accepted.map(
          (file) =>
            new Promise<InputImage>((resolve, reject) => {
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
            })
        )
      ).then(addInputImages);
    },
    [inputImages, addInputImages, t]
  );

  const onChangeFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addFiles(Array.from(e.target.files));
      }
      // Allow selecting the same file again
      e.target.value = '';
    },
    [addFiles]
  );

  // Drag & drop: dropping images anywhere on the settings card switches to
  // edit mode and adds them as edit sources
  const [isDragOver, setIsDragOver] = useState(false);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        setMode('edit');
        addFiles(files);
      }
    },
    [addFiles, setMode]
  );

  // Use a generated image as an edit source for further editing
  const addResultToInputs = useCallback(
    async (image: ResultImage) => {
      if (inputImages.length >= MAX_INPUT_IMAGES) {
        toast.error(
          t('gptImage.error.tooManyImages', { max: MAX_INPUT_IMAGES })
        );
        return;
      }
      try {
        // Fetch a non-expiring thumbnail (object URL); the request itself
        // sends only the S3 URL, which is resolved server-side
        const signedUrl = await getFileDownloadSignedUrl(image.s3Url);
        const res = await fetch(signedUrl);
        if (!res.ok) {
          throw new Error(`Failed to load image (${res.status})`);
        }
        const blob = await res.blob();
        addInputImages([
          {
            previewUrl: URL.createObjectURL(blob),
            s3Url: image.s3Url,
            mediaType: blob.type || 'image/png',
            size: 0,
          },
        ]);
        setMode('edit');
      } catch (e) {
        console.error(e);
        toast.error(t('gptImage.error.downloadFailed'));
      }
    },
    [inputImages, addInputImages, setMode, getFileDownloadSignedUrl, t]
  );

  // Reference an existing chat: its transcript is sent along with the
  // prompt so the image can summarize the conversation's conclusion
  const onSelectChatContext = useCallback(
    (context: ImageChatContext) => {
      setChatContext(context);
      if (prompt.length === 0) {
        setPrompt(t('imageChatContext.defaultPrompt'));
      }
      // Summary slides read best in landscape — GPT Image has no 16:9,
      // so use the closest landscape size
      setSize('1536x1024');
    },
    [setChatContext, prompt, setPrompt, setSize, t]
  );

  const generate = useCallback(async () => {
    setIsGenerating(true);
    try {
      const common = {
        prompt,
        chatContext: chatContext?.transcript,
        size,
        quality,
        n,
      };

      const res =
        mode === 'edit'
          ? await editImage(
              {
                ...common,
                images: inputImages.map(toInputImage),
              },
              chatId
            )
          : await generateImage(common, chatId);

      // The Lambda returns S3 URLs; resolve them to signed URLs for display
      const resultImages = await Promise.all(
        res.images.map(async (s3Url) => ({
          s3Url,
          signedUrl: await getFileDownloadSignedUrl(s3Url),
        }))
      );

      // Append as one exchange of the ongoing session (chat-like timeline)
      addExchange({ prompt, results: resultImages }, res.chatId);
      setPrompt('');
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : `${e}`;
      toast.error(t('gptImage.error.generationFailed', { error: message }), {
        duration: 30000,
        closeButton: true,
      });
    }
    setIsGenerating(false);
  }, [
    mode,
    prompt,
    chatContext,
    size,
    quality,
    n,
    inputImages,
    chatId,
    generateImage,
    editImage,
    getFileDownloadSignedUrl,
    addExchange,
    setPrompt,
    t,
  ]);

  // Bundle every image of the session timeline into a single PDF
  const exportPdf = useCallback(async () => {
    setIsExportingPdf(true);
    try {
      const s3Urls = exchanges.flatMap((exchange) =>
        exchange.results.map((image) => image.s3Url)
      );
      const blobs = await Promise.all(
        s3Urls.map(async (s3Url) => {
          // Signed URLs expire after 60 seconds — always issue fresh ones
          const signedUrl = await getFileDownloadSignedUrl(s3Url);
          const res = await fetch(signedUrl);
          if (!res.ok) {
            throw new Error(`Download failed (${res.status})`);
          }
          return res.blob();
        })
      );
      await exportImagesToPdf(blobs, `gpt-image-${Date.now()}.pdf`);
    } catch (e) {
      console.error(e);
      toast.error(t('imagePdf.error.exportFailed'));
    }
    setIsExportingPdf(false);
  }, [exchanges, getFileDownloadSignedUrl, t]);

  const downloadImage = useCallback(
    async (image: ResultImage, index: number) => {
      try {
        // Signed URLs expire after 60 seconds — always issue a fresh one
        const signedUrl = await getFileDownloadSignedUrl(image.s3Url);
        const res = await fetch(signedUrl);
        if (!res.ok) {
          throw new Error(`Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gpt-image-${Date.now()}-${index}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error(e);
        toast.error(t('gptImage.error.downloadFailed'));
      }
    },
    [getFileDownloadSignedUrl, t]
  );

  const disabledExec = useMemo(() => {
    if (isGenerating || prompt.length === 0) return true;
    if (mode === 'edit' && inputImages.length === 0) return true;
    return false;
  }, [isGenerating, prompt, mode, inputImages]);

  const clearable = useMemo(() => {
    return (
      (prompt.length > 0 ||
        inputImages.length > 0 ||
        exchanges.length > 0 ||
        !!chatContext) &&
      !isGenerating
    );
  }, [prompt, inputImages, exchanges, chatContext, isGenerating]);

  return (
    <div className="grid grid-cols-12 gap-4 p-4">
      <div className="invisible col-span-12 my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {t('gptImage.title')}
      </div>

      <div
        className={`col-span-12 lg:col-span-4 ${
          isDragOver ? 'ring-aws-smile rounded-lg ring-2' : ''
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => {
          setIsDragOver(false);
        }}
        onDrop={onDrop}>
        <Card>
          <Select
            label={t('gptImage.mode.label')}
            value={mode}
            onChange={(v) => {
              setMode(v as GptImageMode);
            }}
            options={[
              { value: 'generate', label: t('gptImage.mode.generate') },
              { value: 'edit', label: t('gptImage.mode.edit') },
            ]}
            fullWidth
          />

          <Textarea
            label={t('gptImage.prompt.label')}
            placeholder={
              mode === 'edit'
                ? t('gptImage.prompt.placeholderEdit')
                : t('gptImage.prompt.placeholderGenerate')
            }
            value={prompt}
            onChange={setPrompt}
            rows={4}
            required
          />

          {/* Reference an existing chat to summarize its conclusion as an image */}
          <div>
            <div className="text-sm">{t('imageChatContext.label')}</div>
            {chatContext ? (
              <div className="my-2 flex items-center gap-x-2 rounded border px-2 py-1 text-sm">
                <PiChatsCircle className="shrink-0 text-base" />
                <span className="grow truncate">
                  {chatContext.title}
                  <span className="ml-1 text-xs text-gray-400">
                    {t('imageChatContext.messageCount', {
                      n: chatContext.messageCount,
                    })}
                  </span>
                </span>
                <ButtonIcon
                  onClick={() => {
                    setChatContext(undefined);
                  }}
                  title={t('imageChatContext.remove')}>
                  <PiX className="text-base" />
                </ButtonIcon>
              </div>
            ) : (
              <div
                className="text-aws-smile border-aws-smile my-2 flex w-full cursor-pointer flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm hover:bg-gray-100"
                onClick={() => {
                  setIsSelectChatOpen(true);
                }}>
                <PiChatsCircle className="mr-1 text-base" />
                {t('imageChatContext.select')}
              </div>
            )}
            <p className="my-1 text-xs text-gray-400">
              {t('imageChatContext.help')}
            </p>
          </div>

          {mode === 'edit' && (
            <div>
              <div className="text-sm">{t('gptImage.uploadImage')}</div>

              <label>
                <input
                  hidden
                  onChange={onChangeFiles}
                  type="file"
                  accept={ACCEPT_MEDIA_TYPES.join(',')}
                  multiple
                  value={[]}
                />
                <div className="text-aws-smile border-aws-smile my-2 flex w-full cursor-pointer flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm hover:bg-gray-100">
                  <PiUpload className="mr-1 text-base" /> {t('gptImage.upload')}
                </div>
              </label>

              <p className="my-1 text-xs text-gray-400">
                {t('gptImage.uploadImageHelp', { max: MAX_INPUT_IMAGES })}
              </p>

              {inputImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {inputImages.map((image, idx) => (
                    <ZoomUpImage
                      key={idx}
                      src={image.previewUrl}
                      size="s"
                      onDelete={() => {
                        removeInputImage(idx);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <Select
            label={t('gptImage.size')}
            value={size}
            onChange={(v) => {
              setSize(v as GptImageSize);
            }}
            options={SIZE_OPTIONS.map((s) => ({
              value: s,
              label: s === 'auto' ? t('gptImage.auto') : s,
            }))}
            fullWidth
          />

          <Select
            label={t('gptImage.quality')}
            value={quality}
            onChange={(v) => {
              setQuality(v as GptImageQuality);
            }}
            options={QUALITY_OPTIONS.map((q) => ({
              value: q,
              label:
                q === 'auto'
                  ? t('gptImage.auto')
                  : t(`gptImage.qualities.${q}`),
            }))}
            fullWidth
          />

          <Select
            label={t('gptImage.numberOfImages')}
            value={`${n}`}
            onChange={(v) => {
              setN(Number(v));
            }}
            options={NUMBER_OPTIONS.map((v) => ({
              value: `${v}`,
              label: `${v}`,
            }))}
            fullWidth
          />

          <div className="mt-4 flex flex-row items-center gap-x-5">
            <Button
              className="h-8 w-full"
              disabled={disabledExec}
              onClick={generate}
              loading={isGenerating}>
              {mode === 'edit' ? t('gptImage.edit') : t('gptImage.generate')}
            </Button>
            <Button
              className="h-8 w-full"
              outlined
              onClick={clear}
              disabled={!clearable}>
              {t('gptImage.clear')}
            </Button>
          </div>
        </Card>
      </div>

      <div className="col-span-12 lg:col-span-8">
        <Card className="lg:min-h-[calc(100vh-2rem)]">
          {exchanges.length === 0 && !isGenerating ? (
            <div className="flex h-72 flex-col items-center justify-center gap-y-2 text-gray-400">
              <PiImages className="h-24 w-24" />
              {t('gptImage.noResults')}
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-end gap-x-4">
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
                    {t('gptImage.viewInHistory')}
                  </Link>
                )}
              </div>
              {/* Chat-like timeline: every prompt → result exchange of the
                  session stays visible, newest at the bottom */}
              <div className="flex flex-col gap-y-6">
                {exchanges.map((exchange, exchangeIdx) => (
                  <div key={exchangeIdx} className="flex flex-col gap-y-2">
                    <div className="flex justify-end">
                      <div className="bg-aws-smile/10 max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm">
                        {exchange.prompt}
                      </div>
                    </div>
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
                              onClick={() => {
                                downloadImage(image, idx);
                              }}
                              title={t('gptImage.download')}>
                              <PiDownload className="text-aws-smile text-base" />
                            </ButtonIcon>
                            <ButtonIcon
                              className="border bg-white"
                              onClick={() => {
                                addResultToInputs(image);
                              }}
                              title={t('gptImage.editThisImage')}>
                              <PiPencilSimple className="text-aws-smile text-base" />
                            </ButtonIcon>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {isGenerating && (
                  <div className="flex flex-col items-center gap-y-2 py-8 text-gray-400">
                    <PiArrowClockwise className="h-12 w-12 animate-spin" />
                    {t('gptImage.generating')}
                  </div>
                )}
                <div ref={timelineBottomRef} />
              </div>
            </>
          )}
        </Card>
      </div>

      <ModalDialogSelectChat
        isOpen={isSelectChatOpen}
        onClose={() => {
          setIsSelectChatOpen(false);
        }}
        onSelect={onSelectChatContext}
      />
    </div>
  );
};

export default GenerateImageGptPage;
