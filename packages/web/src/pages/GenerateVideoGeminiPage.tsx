// Gemini video generation / editing page (Gemini Omni Flash via
// the Google Gemini API interactions endpoint, Workload Identity Federation —
// no API key). Text-to-video, image-to-video, video-to-video editing and
// stateful editing of a previous result (previousInteractionId). Laid out
// like the chat page and the image page: the session in the middle, the
// input box with the model selector at the bottom. Attaching a video (or
// "edit this video" on a result) edits it; images are references.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { create } from 'zustand';
import {
  GeminiInputMedia,
  GeminiVideoResolution,
  GeminiVideoTask,
} from 'generative-ai-use-cases';
import {
  DEFAULT_GEMINI_VIDEO_DURATION,
  DEFAULT_GEMINI_VIDEO_RESOLUTION,
  GEMINI_VIDEO_ASPECT_RATIOS,
  GEMINI_VIDEO_RESOLUTIONS,
  geminiVideoDurations,
} from '@generative-ai-use-cases/common';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  PiArrowsClockwise,
  PiChatsCircle,
  PiDownload,
  PiFilmStrip,
  PiPencilSimple,
} from 'react-icons/pi';
import useGeminiApi from '../hooks/useGeminiApi';
import useFileApi from '../hooks/useFileApi';
import useMediaDownload from '../hooks/useMediaDownload';
import { extractBaseURL } from '../hooks/useFiles';
import useModelPreference from '../hooks/useModelPreference';
import InputChatContent from '../components/InputChatContent';
import Button from '../components/Button';
import ButtonIcon from '../components/ButtonIcon';
import ModalDialog from '../components/ModalDialog';
import ZoomUpImage from '../components/ZoomUpImage';
import ZoomUpVideo from '../components/ZoomUpVideo';
import {
  InputChip,
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
import { VIDEO_MODELS, findMediaModel } from '../utils/mediaModels';

// How attached images are used for a new video: left to the model, or
// stated as the API's task
type ImageUse =
  | 'auto'
  | Extract<GeminiVideoTask, 'image_to_video' | 'reference_to_video'>;
const IMAGE_USE_OPTIONS: ImageUse[] = [
  'auto',
  'image_to_video',
  'reference_to_video',
];
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

// One prompt -> result round trip of the interactive session, recorded as
// one user/assistant message pair of the session's chat
type Exchange = {
  prompt: string;
  modelLabel: string;
  results: ResultVideo[];
  // Interaction ID returned with these results (stateful editing)
  interactionId?: string;
};

type StateType = {
  prompt: string;
  aspectRatio: string;
  resolution: GeminiVideoResolution;
  // Seconds
  duration: number;
  imageUse: ImageUse;
  inputImages: InputMedia[];
  inputVideo?: InputMedia;
  // Interaction ID of a previous result to continue editing statefully
  previousInteractionId?: string;
  exchanges: Exchange[];
  // Chat the ongoing session is recorded into (all exchanges until clear)
  chatId?: string;
  setPrompt: (s: string) => void;
  setAspectRatio: (s: string) => void;
  setResolution: (r: GeminiVideoResolution) => void;
  setDuration: (seconds: number) => void;
  setImageUse: (use: ImageUse) => void;
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
    prompt: '',
    aspectRatio: '16:9',
    resolution: DEFAULT_GEMINI_VIDEO_RESOLUTION as GeminiVideoResolution,
    duration: DEFAULT_GEMINI_VIDEO_DURATION,
    imageUse: 'auto' as ImageUse,
    inputImages: [],
    inputVideo: undefined,
    previousInteractionId: undefined,
    exchanges: [],
    chatId: undefined,
  };
  return {
    ...INIT_STATE,
    setPrompt: (s) => set(() => ({ prompt: s })),
    setAspectRatio: (s) => set(() => ({ aspectRatio: s })),
    setResolution: (r) => set(() => ({ resolution: r })),
    setDuration: (seconds) => set(() => ({ duration: seconds })),
    setImageUse: (use) => set(() => ({ imageUse: use })),
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
    // Starting over keeps the settings the user picked
    clear: () =>
      set((state) => ({
        ...INIT_STATE,
        aspectRatio: state.aspectRatio,
        resolution: state.resolution,
        duration: state.duration,
        imageUse: state.imageUse,
      })),
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
    prompt,
    setPrompt,
    aspectRatio,
    setAspectRatio,
    resolution,
    setResolution,
    duration,
    setDuration,
    imageUse,
    setImageUse,
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
  const { download } = useMediaDownload();
  const [modelValue, setModelValue] = useModelPreference(
    'videoStudioModel',
    VIDEO_MODELS.map((m) => m.value)
  );
  const model = findMediaModel(VIDEO_MODELS, modelValue);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [isSettingOpen, setIsSettingOpen] = useState(false);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

  // A source video or a previous result makes the request an edit
  const isEdit = !!inputVideo || !!previousInteractionId;

  // The settings of a new video. An edit has none: the result follows its
  // source video (the API rejects them there).
  const hasImages = inputImages.length > 0;
  const settingFields: MediaSettingField[] = useMemo(() => {
    if (isEdit) return [];
    return [
      {
        key: 'aspectRatio',
        label: t('geminiVideo.aspectRatio'),
        value: aspectRatio,
        onChange: setAspectRatio,
        options: GEMINI_VIDEO_ASPECT_RATIOS.map((v) => ({
          value: v,
          label:
            v === '9:16'
              ? t('geminiVideo.aspectRatios.portrait')
              : t('geminiVideo.aspectRatios.landscape'),
        })),
        primary: true,
      },
      {
        key: 'duration',
        label: t('geminiVideo.duration'),
        value: `${duration}`,
        onChange: (v: string) => setDuration(Number(v)),
        options: geminiVideoDurations(model?.modelId ?? '').map((v) => ({
          value: `${v}`,
          label: t('geminiVideo.seconds', { n: v }),
        })),
        fallback: `${DEFAULT_GEMINI_VIDEO_DURATION}`,
        primary: true,
        help: t('geminiVideo.durationHelp'),
      },
      {
        key: 'resolution',
        label: t('geminiVideo.resolution'),
        value: resolution,
        onChange: (v: string) => setResolution(v as GeminiVideoResolution),
        options: GEMINI_VIDEO_RESOLUTIONS.map((v) => ({
          value: v,
          label: v === '4k' ? '4K' : v,
        })),
        primary: true,
        help: t('geminiVideo.resolutionHelp'),
      },
      ...(hasImages
        ? [
            {
              key: 'imageUse',
              label: t('geminiVideo.imageUse'),
              value: imageUse,
              onChange: (v: string) => setImageUse(v as ImageUse),
              options: IMAGE_USE_OPTIONS.map((v) => ({
                value: v,
                label: t(`geminiVideo.imageUses.${v}`),
              })),
              primary: true,
              help: t('geminiVideo.imageUseHelp'),
            },
          ]
        : []),
    ];
  }, [
    isEdit,
    hasImages,
    model,
    aspectRatio,
    duration,
    resolution,
    imageUse,
    setAspectRatio,
    setDuration,
    setResolution,
    setImageUse,
    t,
  ]);
  useValidMediaSettings(settingFields);

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
    () => inputImages.reduce((sum, i) => sum + i.size, 0),
    [inputImages]
  );

  const addImageFiles = useCallback(
    (files: File[]) => {
      let total = totalInputSize;
      const accepted: File[] = [];

      for (const file of files) {
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

  // Source videos are uploaded to S3 and passed to the Lambda as an S3 URL
  // (resolved to bytes server-side) — sending them inline as base64 would
  // exceed the 6MB direct-invoke payload limit for any real video
  const uploadVideo = useCallback(
    async (file: File) => {
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

  // One attachment button for both: videos are edited, images are references
  const addFiles = useCallback(
    (files: File[]) => {
      const videos = files.filter((f) => ACCEPT_VIDEO_TYPES.includes(f.type));
      const images = files.filter((f) => ACCEPT_IMAGE_TYPES.includes(f.type));
      if (videos.length + images.length < files.length) {
        toast.error(t('geminiVideo.error.unsupportedFileType'));
      }
      if (videos.length > 0) {
        uploadVideo(videos[0]);
      }
      if (images.length > 0) {
        addImageFiles(images);
      }
    },
    [uploadVideo, addImageFiles, t]
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
      setPrompt('');
    },
    [setPreviousInteractionId, setInputVideo, setPrompt]
  );

  const generate = useCallback(async () => {
    // Enter in the input box also lands here while a generation runs
    if (!model || isGenerating || isUploadingVideo) return;
    setIsGenerating(true);
    try {
      const res = await generateVideo(
        {
          prompt,
          ...(model.modelId ? { model: model.modelId } : {}),
          ...(isEdit
            ? {
                task: 'edit' as const,
                ...(previousInteractionId ? { previousInteractionId } : {}),
                ...(inputVideo ? { videos: [toInputMedia(inputVideo)] } : {}),
              }
            : {
                aspectRatio,
                resolution,
                duration,
                ...(inputImages.length > 0 && imageUse !== 'auto'
                  ? { task: imageUse }
                  : {}),
              }),
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

      addExchange(
        {
          prompt,
          // The settings the video was made with, beside the model
          modelLabel: [
            model.label,
            ...(isEdit
              ? []
              : [
                  aspectRatio,
                  resolution === '4k' ? '4K' : resolution,
                  t('geminiVideo.seconds', { n: duration }),
                ]),
          ].join(' · '),
          results: resultVideos,
          interactionId: res.interactionId,
        },
        res.chatId
      );
      setPrompt('');

      // While editing, chain the next edit onto the result just produced so
      // consecutive prompts keep refining the latest video
      if (isEdit && res.interactionId) {
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
    model,
    isGenerating,
    isUploadingVideo,
    isEdit,
    prompt,
    aspectRatio,
    resolution,
    duration,
    imageUse,
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
    (video: ResultVideo, index: number) =>
      download(
        video.s3Url,
        `video-${Date.now()}-${index}.mp4`,
        t('geminiVideo.error.downloadFailed')
      ),
    [download, t]
  );

  const onReset = useCallback(() => {
    clear();
  }, [clear]);

  const topContent = (previousInteractionId ||
    inputVideo ||
    inputImages.length > 0) && (
    <div className="flex flex-wrap items-center gap-2 p-2">
      {previousInteractionId && (
        <InputChip
          icon={<PiArrowsClockwise />}
          removeLabel={t('geminiVideo.stopEditing')}
          onRemove={() => setPreviousInteractionId(undefined)}>
          {t('geminiVideo.continueEditing')}
        </InputChip>
      )}
      {inputVideo && (
        <ZoomUpVideo
          src={inputVideo.previewUrl}
          size="s"
          onDelete={() => setInputVideo(undefined)}
        />
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
        title={t('geminiVideo.title')}
        description={t('geminiVideo.description', {
          maxImages: MAX_INPUT_IMAGES,
          maxVideoMb: MAX_VIDEO_SIZE_MB,
        })}
        emptyIcon={<PiFilmStrip className="h-24 w-24" />}
        emptyText={t('geminiVideo.noResults')}
        isEmpty={exchanges.length === 0 && !isGenerating}
        onDropFiles={addFiles}
        actions={
          chatId && (
            <Link
              className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline"
              to={`/chat/${chatId}`}>
              <PiChatsCircle className="text-base" />
              {t('geminiVideo.viewInHistory')}
            </Link>
          )
        }
        input={
          <InputChatContent
            content={prompt}
            onChangeContent={setPrompt}
            placeholder={
              isEdit
                ? t('geminiVideo.placeholder.edit')
                : t('geminiVideo.placeholder.generate')
            }
            onSend={generate}
            loading={isGenerating || isUploadingVideo}
            disabled={!model}
            isEmpty={exchanges.length === 0}
            onReset={onReset}
            topContent={topContent}
            bottomContent={
              <MediaSettingsBar
                fields={settingFields}
                note={
                  isEdit ? t('geminiVideo.settingsInheritedHelp') : undefined
                }
                disabled={isGenerating}
              />
            }
            onPasteFiles={addFiles}
            toolbarStart={
              <MediaAttachButton
                accept={[...ACCEPT_VIDEO_TYPES, ...ACCEPT_IMAGE_TYPES]}
                hasFiles={!!inputVideo || inputImages.length > 0}
                loading={isUploadingVideo}
                disabled={isGenerating}
                onFiles={addFiles}
              />
            }
            modelId={modelValue}
            onModelChange={setModelValue}
            modelOptions={VIDEO_MODELS}
            setting
            onSetting={() => setIsSettingOpen(true)}
          />
        }>
        {exchanges.map((exchange, exchangeIdx) => (
          <MediaExchange
            key={exchangeIdx}
            prompt={exchange.prompt}
            modelLabel={exchange.modelLabel}>
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
                    onClick={() => downloadVideo(video, idx)}
                    title={t('geminiVideo.download')}>
                    <PiDownload className="text-aws-smile text-base" />
                  </ButtonIcon>
                  <ButtonIcon
                    className="border bg-white"
                    onClick={() => editResult(video, exchange.interactionId)}
                    title={t('geminiVideo.editThisVideo')}>
                    <PiPencilSimple className="text-aws-smile text-base" />
                  </ButtonIcon>
                </div>
              </div>
            ))}
          </MediaExchange>
        ))}
        {isGenerating && <MediaGenerating text={t('geminiVideo.generating')} />}
        <div ref={timelineBottomRef} />
      </MediaSessionLayout>

      <ModalDialog
        isOpen={isSettingOpen}
        onClose={() => setIsSettingOpen(false)}
        title={t('geminiVideo.settings')}>
        <div className="flex flex-col gap-2">
          {/* Edits inherit the source video's settings (API rejects them) */}
          {isEdit ? (
            <p className="text-sm text-gray-600">
              {t('geminiVideo.settingsInheritedHelp')}
            </p>
          ) : (
            <MediaSettingsForm fields={settingFields} />
          )}
          <p className="text-xs text-gray-400">
            {t('geminiVideo.generationTimeNote')}
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => setIsSettingOpen(false)}>
            {t('geminiVideo.settingsDone')}
          </Button>
        </div>
      </ModalDialog>
    </>
  );
};

export default GenerateVideoGeminiPage;
