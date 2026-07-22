// Fork custom: Gemini video generation / editing page (Gemini Omni Flash via
// the Google Gemini API interactions endpoint, Workload Identity Federation —
// no API key). Text-to-video, image-to-video, video-to-video editing and
// stateful editing of a previous result (previousInteractionId).
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import { GeminiInputMedia } from 'generative-ai-use-cases';
import useGeminiApi from '../hooks/useGeminiApi';
import useFileApi from '../hooks/useFileApi';
import { extractBaseURL } from '../hooks/useFiles';
import Card from '../components/Card';
import Textarea from '../components/Textarea';
import Select from '../components/Select';
import Button from '../components/Button';
import ButtonIcon from '../components/ButtonIcon';
import ZoomUpImage from '../components/ZoomUpImage';
import ZoomUpVideo from '../components/ZoomUpVideo';
import {
  PiArrowClockwise,
  PiChatsCircle,
  PiDownload,
  PiFilmStrip,
  PiPencilSimple,
  PiUpload,
  PiX,
} from 'react-icons/pi';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

type GeminiVideoMode = 'generate' | 'edit';

const ASPECT_RATIO_OPTIONS = ['16:9', '9:16'];
const MAX_INPUT_IMAGES = 3;
// Keep the direct-invoke payload within the Lambda limit (6MB);
// base64 encoding inflates the raw size by ~4/3
const MAX_TOTAL_INPUT_SIZE = 4 * 1024 * 1024;
// Uploaded source videos go through S3 (not the invoke payload), so the
// limit is the Gemini API request cap (~20MB) minus base64 inflation
const MAX_VIDEO_SIZE = 14 * 1024 * 1024;
const MAX_VIDEO_SIZE_MB = 14;
const ACCEPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ACCEPT_VIDEO_TYPES = ['video/mp4', 'video/webm'];

type InputMedia = {
  // URL used for the preview (data URI or object URL — never expires)
  previewUrl: string;
  mediaType: string;
  // Raw size counted toward the payload cap (0 for s3-backed media)
  size: number;
  // Exactly one of the following is set:
  dataUrl?: string; // local upload (data URI, sent as base64)
  s3Url?: string; // reused generated media (sent as S3 URL, resolved server-side)
};

type ResultVideo = {
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
  results: ResultVideo[];
  // Interaction ID returned with these results (stateful editing)
  interactionId?: string;
};

type StateType = {
  mode: GeminiVideoMode;
  prompt: string;
  aspectRatio: string;
  inputImages: InputMedia[];
  inputVideo?: InputMedia;
  // Interaction ID of a previous result to continue editing statefully
  previousInteractionId?: string;
  exchanges: Exchange[];
  // Chat the ongoing session is recorded into (all exchanges until clear)
  chatId?: string;
  setMode: (m: GeminiVideoMode) => void;
  setPrompt: (s: string) => void;
  setAspectRatio: (s: string) => void;
  addInputImages: (images: InputMedia[]) => void;
  removeInputImage: (index: number) => void;
  setInputVideo: (video?: InputMedia) => void;
  setPreviousInteractionId: (id?: string) => void;
  addExchange: (exchange: Exchange, chatId?: string) => void;
  setExchanges: (exchanges: Exchange[]) => void;
  clear: () => void;
};

const useGenerateVideoGeminiPageState = create<StateType>((set) => {
  const INIT_STATE = {
    mode: 'generate' as GeminiVideoMode,
    prompt: '',
    aspectRatio: '16:9',
    inputImages: [],
    inputVideo: undefined,
    previousInteractionId: undefined,
    exchanges: [],
    chatId: undefined,
  };
  return {
    ...INIT_STATE,
    setMode: (m) => set(() => ({ mode: m })),
    setPrompt: (s) => set(() => ({ prompt: s })),
    setAspectRatio: (s) => set(() => ({ aspectRatio: s })),
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
    setInputVideo: (video) => set(() => ({ inputVideo: video })),
    setPreviousInteractionId: (id) =>
      set(() => ({ previousInteractionId: id })),
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

const toInputMedia = (media: InputMedia): GeminiInputMedia => {
  if (media.s3Url) {
    return { s3Url: media.s3Url, mediaType: media.mediaType };
  }
  return {
    data: media.dataUrl!.split(',')[1],
    mediaType: media.mediaType,
  };
};

const readAsInputMedia = (file: File): Promise<InputMedia> =>
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

const GenerateVideoGeminiPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    mode,
    setMode,
    prompt,
    setPrompt,
    aspectRatio,
    setAspectRatio,
    inputImages,
    addInputImages,
    removeInputImage,
    inputVideo,
    setInputVideo,
    previousInteractionId,
    setPreviousInteractionId,
    exchanges,
    chatId,
    addExchange,
    setExchanges,
    clear,
  } = useGenerateVideoGeminiPageState();
  const { generateVideo } = useGeminiApi();
  const { getFileDownloadSignedUrl, getSignedUrl, uploadFile } = useFileApi();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

  // Results persist in the store across navigation, but signed URLs expire
  // after 60 seconds — re-issue them when the page mounts
  useEffect(() => {
    if (exchanges.length === 0) return;
    Promise.all(
      exchanges.map(async (exchange) => ({
        ...exchange,
        results: await Promise.all(
          exchange.results.map(async (video) => ({
            s3Url: video.s3Url,
            signedUrl: await getFileDownloadSignedUrl(video.s3Url),
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

  const totalInputSize = useMemo(
    () =>
      inputImages.reduce((sum, i) => sum + i.size, 0) + (inputVideo?.size ?? 0),
    [inputImages, inputVideo]
  );

  const addImageFiles = useCallback(
    (files: File[]) => {
      let total = totalInputSize;
      const accepted: File[] = [];

      for (const file of files) {
        if (!ACCEPT_IMAGE_TYPES.includes(file.type)) {
          toast.error(t('geminiVideo.error.unsupportedFileType'));
          continue;
        }
        if (inputImages.length + accepted.length >= MAX_INPUT_IMAGES) {
          toast.error(
            t('geminiVideo.error.tooManyImages', { max: MAX_INPUT_IMAGES })
          );
          break;
        }
        if (total + file.size > MAX_TOTAL_INPUT_SIZE) {
          toast.error(t('geminiVideo.error.fileTooLarge'));
          continue;
        }
        total += file.size;
        accepted.push(file);
      }

      Promise.all(accepted.map(readAsInputMedia)).then(addInputImages);
    },
    [inputImages, totalInputSize, addInputImages, t]
  );

  const onChangeImageFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addImageFiles(Array.from(e.target.files));
      }
      // Allow selecting the same file again
      e.target.value = '';
    },
    [addImageFiles]
  );

  // Source videos are uploaded to S3 and passed to the Lambda as an S3 URL
  // (resolved to bytes server-side) — sending them inline as base64 would
  // exceed the 6MB direct-invoke payload limit for any real video
  const onChangeVideoFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (!ACCEPT_VIDEO_TYPES.includes(file.type)) {
        toast.error(t('geminiVideo.error.unsupportedFileType'));
        return;
      }
      if (file.size > MAX_VIDEO_SIZE) {
        toast.error(
          t('geminiVideo.error.videoTooLarge', { max: MAX_VIDEO_SIZE_MB })
        );
        return;
      }
      setIsUploadingVideo(true);
      try {
        const signedUrlRes = await getSignedUrl({
          filename: file.name,
          mediaFormat: file.name.split('.').pop() ?? '',
        });
        const signedUrl = signedUrlRes.data;
        await uploadFile(signedUrl, { file });
        // Uploading a video replaces stateful editing of a previous result
        setPreviousInteractionId(undefined);
        setInputVideo({
          previewUrl: URL.createObjectURL(file),
          s3Url: extractBaseURL(signedUrl),
          mediaType: file.type,
          size: 0,
        });
      } catch (err) {
        console.error(err);
        toast.error(t('geminiVideo.error.uploadFailed'));
      }
      setIsUploadingVideo(false);
    },
    [getSignedUrl, uploadFile, setInputVideo, setPreviousInteractionId, t]
  );

  // Continue editing a generated video: prefer stateful editing via the
  // interaction ID of the exchange it belongs to; fall back to sending the
  // video itself (S3 URL, resolved server-side) when none is available
  const editResult = useCallback(
    (video: ResultVideo, interactionId?: string) => {
      if (interactionId) {
        setPreviousInteractionId(interactionId);
        setInputVideo(undefined);
      } else {
        setPreviousInteractionId(undefined);
        setInputVideo({
          previewUrl: video.signedUrl,
          s3Url: video.s3Url,
          mediaType: 'video/mp4',
          size: 0,
        });
      }
      setMode('edit');
      setPrompt('');
    },
    [setPreviousInteractionId, setInputVideo, setMode, setPrompt]
  );

  const generate = useCallback(async () => {
    setIsGenerating(true);
    try {
      const res = await generateVideo(
        {
          prompt,
          aspectRatio,
          ...(mode === 'edit'
            ? {
                task: 'edit' as const,
                ...(previousInteractionId ? { previousInteractionId } : {}),
                ...(inputVideo ? { videos: [toInputMedia(inputVideo)] } : {}),
              }
            : {}),
          ...(inputImages.length > 0
            ? { images: inputImages.map(toInputMedia) }
            : {}),
        },
        chatId
      );

      // The Lambda returns S3 URLs; resolve them to signed URLs for display
      const resultVideos = await Promise.all(
        res.files.map(async (s3Url) => ({
          s3Url,
          signedUrl: await getFileDownloadSignedUrl(s3Url),
        }))
      );

      // Append as one exchange of the ongoing session (chat-like timeline)
      addExchange(
        { prompt, results: resultVideos, interactionId: res.interactionId },
        res.chatId
      );
      setPrompt('');

      // In edit mode, chain the next edit onto the result just produced so
      // consecutive prompts keep refining the latest video
      if (mode === 'edit' && res.interactionId) {
        setPreviousInteractionId(res.interactionId);
        setInputVideo(undefined);
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : `${e}`;
      toast.error(t('geminiVideo.error.generationFailed', { error: message }), {
        duration: 30000,
        closeButton: true,
      });
    }
    setIsGenerating(false);
  }, [
    mode,
    prompt,
    aspectRatio,
    inputImages,
    inputVideo,
    previousInteractionId,
    chatId,
    generateVideo,
    getFileDownloadSignedUrl,
    addExchange,
    setPrompt,
    setPreviousInteractionId,
    setInputVideo,
    t,
  ]);

  const downloadVideo = useCallback(
    async (video: ResultVideo, index: number) => {
      try {
        // Signed URLs expire after 60 seconds — always issue a fresh one
        const signedUrl = await getFileDownloadSignedUrl(video.s3Url);
        const res = await fetch(signedUrl);
        if (!res.ok) {
          throw new Error(`Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gemini-video-${Date.now()}-${index}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error(e);
        toast.error(t('geminiVideo.error.downloadFailed'));
      }
    },
    [getFileDownloadSignedUrl, t]
  );

  const disabledExec = useMemo(() => {
    if (isGenerating || isUploadingVideo || prompt.length === 0) return true;
    if (mode === 'edit' && !previousInteractionId && !inputVideo) return true;
    return false;
  }, [
    isGenerating,
    isUploadingVideo,
    prompt,
    mode,
    previousInteractionId,
    inputVideo,
  ]);

  const clearable = useMemo(() => {
    return (
      (prompt.length > 0 ||
        inputImages.length > 0 ||
        !!inputVideo ||
        !!previousInteractionId ||
        exchanges.length > 0) &&
      !isGenerating
    );
  }, [
    prompt,
    inputImages,
    inputVideo,
    previousInteractionId,
    exchanges,
    isGenerating,
  ]);

  return (
    <div className="grid grid-cols-12 gap-4 p-4">
      <div className="invisible col-span-12 my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {t('geminiVideo.title')}
      </div>

      <div className="col-span-12 lg:col-span-4">
        <Card>
          <Select
            label={t('geminiVideo.mode.label')}
            value={mode}
            onChange={(v) => {
              setMode(v as GeminiVideoMode);
            }}
            options={[
              { value: 'generate', label: t('geminiVideo.mode.generate') },
              { value: 'edit', label: t('geminiVideo.mode.edit') },
            ]}
            fullWidth
          />

          <Textarea
            label={t('geminiVideo.prompt.label')}
            placeholder={
              mode === 'edit'
                ? t('geminiVideo.prompt.placeholderEdit')
                : t('geminiVideo.prompt.placeholderGenerate')
            }
            value={prompt}
            onChange={setPrompt}
            rows={4}
            required
          />

          {mode === 'edit' && (
            <div>
              {previousInteractionId ? (
                <div className="bg-aws-smile/10 border-aws-smile text-aws-smile my-2 flex items-center justify-between rounded border px-2 py-1 text-sm">
                  <span>{t('geminiVideo.continueEditing')}</span>
                  <ButtonIcon
                    onClick={() => {
                      setPreviousInteractionId(undefined);
                    }}>
                    <PiX />
                  </ButtonIcon>
                </div>
              ) : (
                <>
                  <div className="text-sm">{t('geminiVideo.uploadVideo')}</div>
                  <label
                    className={
                      isUploadingVideo ? 'pointer-events-none opacity-50' : ''
                    }>
                    <input
                      hidden
                      onChange={onChangeVideoFile}
                      type="file"
                      accept={ACCEPT_VIDEO_TYPES.join(',')}
                      disabled={isUploadingVideo}
                      value={[]}
                    />
                    <div className="text-aws-smile border-aws-smile my-2 flex w-full cursor-pointer flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm hover:bg-gray-100">
                      {isUploadingVideo ? (
                        <PiArrowClockwise className="mr-1 animate-spin text-base" />
                      ) : (
                        <PiUpload className="mr-1 text-base" />
                      )}{' '}
                      {isUploadingVideo
                        ? t('geminiVideo.uploading')
                        : t('geminiVideo.upload')}
                    </div>
                  </label>
                  <p className="my-1 text-xs text-gray-400">
                    {t('geminiVideo.uploadVideoHelp', {
                      max: MAX_VIDEO_SIZE_MB,
                    })}
                  </p>
                  {inputVideo && (
                    <ZoomUpVideo
                      src={inputVideo.previewUrl}
                      size="s"
                      onDelete={() => {
                        setInputVideo(undefined);
                      }}
                    />
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'generate' && (
            <div>
              <div className="text-sm">{t('geminiVideo.referenceImages')}</div>

              <label>
                <input
                  hidden
                  onChange={onChangeImageFiles}
                  type="file"
                  accept={ACCEPT_IMAGE_TYPES.join(',')}
                  multiple
                  value={[]}
                />
                <div className="text-aws-smile border-aws-smile my-2 flex w-full cursor-pointer flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm hover:bg-gray-100">
                  <PiUpload className="mr-1 text-base" />{' '}
                  {t('geminiVideo.upload')}
                </div>
              </label>

              <p className="my-1 text-xs text-gray-400">
                {t('geminiVideo.referenceImagesHelp', {
                  max: MAX_INPUT_IMAGES,
                })}
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

          {/* Edits inherit the source video's aspect ratio (API rejects it) */}
          {mode === 'generate' && (
            <Select
              label={t('geminiVideo.aspectRatio')}
              value={aspectRatio}
              onChange={setAspectRatio}
              options={ASPECT_RATIO_OPTIONS.map((s) => ({
                value: s,
                label: s,
              }))}
              fullWidth
            />
          )}

          <p className="text-xs text-gray-400">
            {t('geminiVideo.generationTimeNote')}
          </p>

          <div className="mt-4 flex flex-row items-center gap-x-5">
            <Button
              className="h-8 w-full"
              disabled={disabledExec}
              onClick={generate}
              loading={isGenerating}>
              {mode === 'edit'
                ? t('geminiVideo.edit')
                : t('geminiVideo.generate')}
            </Button>
            <Button
              className="h-8 w-full"
              outlined
              onClick={clear}
              disabled={!clearable}>
              {t('geminiVideo.clear')}
            </Button>
          </div>
        </Card>
      </div>

      <div className="col-span-12 lg:col-span-8">
        <Card className="lg:min-h-[calc(100vh-2rem)]">
          {exchanges.length === 0 && !isGenerating ? (
            <div className="flex h-72 flex-col items-center justify-center gap-y-2 text-gray-400">
              <PiFilmStrip className="h-24 w-24" />
              {t('geminiVideo.noResults')}
            </div>
          ) : (
            <>
              {chatId && (
                <div className="mb-4 flex items-center justify-end">
                  <Link
                    className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline"
                    to={`/chat/${chatId}`}>
                    <PiChatsCircle className="text-base" />
                    {t('geminiVideo.viewInHistory')}
                  </Link>
                </div>
              )}
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
                    <div className="grid grid-cols-1 gap-4">
                      {exchange.results.map((video, idx) => (
                        <div key={idx} className="relative">
                          <video
                            className="w-full rounded border"
                            src={video.signedUrl}
                            controls
                          />
                          <div className="absolute right-2 top-2 flex flex-col gap-y-2">
                            <ButtonIcon
                              className="border bg-white"
                              onClick={() => {
                                downloadVideo(video, idx);
                              }}
                              title={t('geminiVideo.download')}>
                              <PiDownload className="text-aws-smile text-base" />
                            </ButtonIcon>
                            <ButtonIcon
                              className="border bg-white"
                              onClick={() => {
                                editResult(video, exchange.interactionId);
                              }}
                              title={t('geminiVideo.editThisVideo')}>
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
                    {t('geminiVideo.generating')}
                  </div>
                )}
                <div ref={timelineBottomRef} />
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

export default GenerateVideoGeminiPage;
