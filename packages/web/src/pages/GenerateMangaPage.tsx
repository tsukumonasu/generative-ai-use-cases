// Manga generation page.
// An LLM storyboards the scenario (free text and/or a referenced chat) into
// pages and panels, then each page is rendered as ONE image by Gemini or
// GPT Image. A character reference sheet and the previous page are passed as
// reference images so the cast stays consistent from page to page.
// The state lives in hooks/useMangaState.ts, the plan -> character sheet ->
// pages orchestration in hooks/useMangaGeneration.ts.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  GeminiImageSize,
  GptImageQuality,
  GptImageSize,
} from 'generative-ai-use-cases';
import useFileApi from '../hooks/useFileApi';
import { MODELS } from '../hooks/useModel';
import useModelPreference from '../hooks/useModelPreference';
import useMediaDownload from '../hooks/useMediaDownload';
import useMangaState, {
  MangaResultImage,
  TASTE_PRESETS,
} from '../hooks/useMangaState';
import useMangaGeneration from '../hooks/useMangaGeneration';
import {
  IMAGE_MODELS,
  ImageProvider,
  findMediaModel,
  geminiImageSizes,
} from '../utils/mediaModels';
import Card from '../components/Card';
import Textarea from '../components/Textarea';
import Select from '../components/Select';
import SelectCompact from '../components/SelectCompact';
import Button from '../components/Button';
import ButtonIcon from '../components/ButtonIcon';
import Switch from '../components/Switch';
import ExpandableField from '../components/ExpandableField';
import ModalDialogSelectChat from '../components/ModalDialogSelectChat';
import MangaCastPhotoPanel from '../components/manga/MangaCastPhotoPanel';
import { MangaReadingDirection, MAX_MANGA_PAGES } from '../utils/mangaPlanner';
import { exportImagesToPdf } from '../utils/exportImagesPdf';
import {
  PiArrowClockwise,
  PiBookOpen,
  PiChatsCircle,
  PiDownload,
  PiFilePdf,
  PiX,
} from 'react-icons/pi';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const ASPECT_RATIO_OPTIONS = ['3:4', '2:3', '9:16', '1:1', '16:9'];
// The whole manga is bundled into one PDF, so the default is the smallest
// size / lowest quality — a many-page 2K+ manga makes a huge file
const GPT_SIZE_OPTIONS: GptImageSize[] = [
  '1024x1536',
  '1024x1024',
  '1536x1024',
];
const QUALITY_OPTIONS: GptImageQuality[] = ['auto', 'low', 'medium', 'high'];
const PAGE_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, MAX_MANGA_PAGES];

const GenerateMangaPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    scenario,
    setScenario,
    taste,
    setTaste,
    tasteDetail,
    setTasteDetail,
    readingDirection,
    setReadingDirection,
    pageCount,
    setPageCount,
    aspectRatio,
    setAspectRatio,
    imageSize,
    setImageSize,
    gptSize,
    setGptSize,
    quality,
    setQuality,
    useCharacterSheet,
    setUseCharacterSheet,
    castPhotos,
    chatContext,
    setChatContext,
    plan,
    characterSheet,
    pages,
    setResults,
    chatId,
    clear,
  } = useMangaState();

  const { getFileDownloadSignedUrl } = useFileApi();
  const { fetchBlob, download } = useMediaDownload();

  const [isSelectChatOpen, setIsSelectChatOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const timelineBottomRef = useRef<HTMLDivElement>(null);

  // Reading the cast photos requires a vision-capable planner model
  const plannerModelIds = useMemo(
    () => (castPhotos.length > 0 ? MODELS.visionModelIds : MODELS.modelIds),
    [castPhotos.length]
  );

  // Remembered per browser like the drawing model; a saved model that cannot
  // read the photos falls back to the first vision model
  const [plannerModelId, setPlannerModelId] = useModelPreference(
    'mangaPlannerModelId',
    plannerModelIds
  );

  // The image model, from the same list as the image page (remembered per
  // browser); its provider decides the settings and the API to call
  const [imageModelValue, setImageModelValue] = useModelPreference(
    'mangaImageModel',
    IMAGE_MODELS.map((m) => m.value)
  );
  const imageModel = findMediaModel(IMAGE_MODELS, imageModelValue);
  const activeProvider: ImageProvider = imageModel?.provider ?? 'gemini';

  const { isRunning, status, regeneratingPage, generate, regeneratePage } =
    useMangaGeneration({ imageModel, plannerModelId });

  // Gemini image sizes depend on the model
  const imageSizeOptions = useMemo(
    () =>
      imageModel?.provider === 'gemini'
        ? geminiImageSizes(imageModel.modelId)
        : [],
    [imageModel]
  );
  useEffect(() => {
    if (imageSizeOptions.length > 0 && !imageSizeOptions.includes(imageSize)) {
      setImageSize(imageSizeOptions[0] as GeminiImageSize);
    }
  }, [imageSizeOptions, imageSize, setImageSize]);

  // Results persist in the store across navigation, but signed URLs expire
  // after 60 seconds — re-issue them when the page mounts
  useEffect(() => {
    if (!characterSheet && pages.length === 0) return;
    const resign = async (
      image: MangaResultImage
    ): Promise<MangaResultImage> => ({
      s3Url: image.s3Url,
      signedUrl: await getFileDownloadSignedUrl(image.s3Url),
    });
    Promise.all([
      characterSheet ? resign(characterSheet) : Promise.resolve(undefined),
      Promise.all(
        pages.map(async (page) => ({
          ...page,
          image: await resign(page.image),
        }))
      ),
    ]).then(([sheet, resigned]) => {
      setResults(sheet, resigned);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest page (or the progress indicator) in view
  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pages.length, isRunning]);

  const downloadImage = useCallback(
    (image: MangaResultImage, filename: string) =>
      download(image.s3Url, filename, t('manga.error.downloadFailed')),
    [download, t]
  );

  // Bundle the story pages (not the character sheet) into a single PDF
  const exportPdf = useCallback(async () => {
    setIsExportingPdf(true);
    try {
      const blobs = await Promise.all(
        [...pages]
          .sort((a, b) => a.pageNumber - b.pageNumber)
          .map((page) => fetchBlob(page.image.s3Url))
      );
      await exportImagesToPdf(blobs, `manga-${Date.now()}.pdf`);
    } catch (e) {
      console.error(e);
      toast.error(t('imagePdf.error.exportFailed'));
    }
    setIsExportingPdf(false);
  }, [pages, fetchBlob, t]);

  const busy = isRunning || regeneratingPage !== null;

  // A photo without a name cannot be cast as a character
  const missingCastPhotoName = useMemo(
    () => castPhotos.some((photo) => photo.name.trim().length === 0),
    [castPhotos]
  );

  const disabledExec = useMemo(() => {
    if (busy || isUploadingPhoto || missingCastPhotoName) return true;
    // Either a scenario or a referenced chat is required as source material
    return scenario.trim().length === 0 && !chatContext;
  }, [busy, isUploadingPhoto, missingCastPhotoName, scenario, chatContext]);

  const clearable = useMemo(() => {
    return (
      !busy &&
      (scenario.length > 0 ||
        tasteDetail.length > 0 ||
        castPhotos.length > 0 ||
        !!chatContext ||
        !!plan ||
        pages.length > 0)
    );
  }, [busy, scenario, tasteDetail, castPhotos, chatContext, plan, pages]);

  return (
    <div className="grid grid-cols-12 gap-4 p-4">
      <div className="invisible col-span-12 my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {t('manga.title')}
      </div>

      <div className="col-span-12 lg:col-span-4">
        <Card>
          <Textarea
            label={t('manga.scenario.label')}
            placeholder={t('manga.scenario.placeholder')}
            value={scenario}
            onChange={setScenario}
            rows={6}
          />
          <p className="-mt-2 text-xs text-gray-400">
            {t('manga.scenario.help')}
          </p>

          {/* Reference an existing chat as the source material */}
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
              <button
                type="button"
                className="text-aws-smile border-aws-smile my-2 flex w-full cursor-pointer flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm hover:bg-gray-100"
                onClick={() => {
                  setIsSelectChatOpen(true);
                }}>
                <PiChatsCircle className="mr-1 text-base" />
                {t('imageChatContext.select')}
              </button>
            )}
            <p className="my-1 text-xs text-gray-400">
              {t('manga.chatContextHelp')}
            </p>
          </div>

          <MangaCastPhotoPanel
            isUploading={isUploadingPhoto}
            onUploadingChange={setIsUploadingPhoto}
            missingName={missingCastPhotoName}
          />

          <Select
            label={t('manga.taste.label')}
            value={taste}
            onChange={setTaste}
            options={TASTE_PRESETS.map((preset) => ({
              value: preset.value,
              label: t(`manga.tastes.${preset.value}`),
            }))}
            fullWidth
          />

          <Textarea
            label={t('manga.taste.detailLabel')}
            placeholder={t('manga.taste.detailPlaceholder')}
            value={tasteDetail}
            onChange={setTasteDetail}
            rows={2}
          />

          <Select
            label={t('manga.readingDirection.label')}
            value={readingDirection}
            onChange={(v) => {
              setReadingDirection(v as MangaReadingDirection);
            }}
            options={[
              { value: 'rtl', label: t('manga.readingDirection.rtl') },
              { value: 'ltr', label: t('manga.readingDirection.ltr') },
            ]}
            fullWidth
          />

          <Select
            label={t('manga.pageCount.label')}
            value={pageCount}
            onChange={setPageCount}
            options={[
              { value: 'auto', label: t('manga.pageCount.auto') },
              ...PAGE_COUNT_OPTIONS.map((v) => ({
                value: `${v}`,
                label: `${v}`,
              })),
            ]}
            fullWidth
          />
          <p className="-mt-2 text-xs text-gray-400">
            {t('manga.pageCount.help', { max: MAX_MANGA_PAGES })}
          </p>

          {activeProvider === 'gemini' ? (
            <>
              <Select
                label={t('manga.aspectRatio')}
                value={aspectRatio}
                onChange={setAspectRatio}
                options={ASPECT_RATIO_OPTIONS.map((v) => ({
                  value: v,
                  label: v,
                }))}
                fullWidth
              />
              <Select
                label={t('manga.imageSize')}
                value={imageSize}
                onChange={(v) => {
                  setImageSize(v as GeminiImageSize);
                }}
                options={imageSizeOptions.map((v) => ({
                  value: v,
                  label: v,
                }))}
                fullWidth
              />
              <p className="-mt-2 text-xs text-gray-400">
                {t('manga.imageSizeHelp')}
              </p>
            </>
          ) : (
            <>
              <Select
                label={t('manga.pageSize')}
                value={gptSize}
                onChange={(v) => {
                  setGptSize(v as GptImageSize);
                }}
                options={GPT_SIZE_OPTIONS.map((v) => ({
                  value: v,
                  label: v,
                }))}
                fullWidth
              />
              <Select
                label={t('manga.quality')}
                value={quality}
                onChange={(v) => {
                  setQuality(v as GptImageQuality);
                }}
                options={QUALITY_OPTIONS.map((v) => ({
                  value: v,
                  label: t(`manga.qualities.${v}`),
                }))}
                fullWidth
              />
            </>
          )}

          <Switch
            className="mt-2"
            label={t('manga.characterSheet.label')}
            checked={useCharacterSheet}
            onSwitch={setUseCharacterSheet}
          />
          <p className="my-1 text-xs text-gray-400">
            {t('manga.characterSheet.help')}
          </p>
          {castPhotos.length > 0 && !useCharacterSheet && (
            <p className="my-1 text-xs text-amber-600">
              {t('manga.castPhotos.characterSheetNote')}
            </p>
          )}

          {/* The models, at the bottom next to the generate button like the
              model selector of the chat input */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SelectCompact
              label={t('manga.imageModel')}
              value={imageModelValue}
              onChange={setImageModelValue}
              options={IMAGE_MODELS.map((m) => ({
                value: m.value,
                label: t('manga.imageModelOption', { name: m.label }),
              }))}
              disabled={busy}
            />
            <SelectCompact
              label={t('manga.plannerModel')}
              value={plannerModelId}
              onChange={setPlannerModelId}
              options={plannerModelIds.map((modelId: string) => ({
                value: modelId,
                label: t('manga.plannerModelOption', {
                  name: MODELS.modelDisplayName(modelId),
                }),
              }))}
              disabled={busy}
            />
          </div>
          {castPhotos.length > 0 && (
            <p className="mt-1 text-xs text-gray-400">
              {t('manga.castPhotos.plannerModelNote')}
            </p>
          )}

          <div className="mt-4 flex flex-row items-center gap-x-5">
            <Button
              className="h-8 w-full"
              disabled={disabledExec}
              onClick={generate}
              loading={isRunning}>
              {t('manga.generate')}
            </Button>
            <Button
              className="h-8 w-full"
              outlined
              onClick={clear}
              disabled={!clearable}>
              {t('manga.clear')}
            </Button>
          </div>

          <p className="mt-2 text-xs text-gray-400">{t('manga.timeNote')}</p>
        </Card>
      </div>

      <div className="col-span-12 lg:col-span-8">
        <Card className="lg:min-h-[calc(100vh-2rem)]">
          {!plan && !isRunning ? (
            <div className="flex h-72 flex-col items-center justify-center gap-y-2 text-gray-400">
              <PiBookOpen className="h-24 w-24" />
              {t('manga.noResults')}
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-end gap-x-4">
                {pages.length > 0 && (
                  <button
                    className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline disabled:opacity-50"
                    disabled={isExportingPdf}
                    onClick={exportPdf}>
                    {isExportingPdf ? (
                      <PiArrowClockwise className="animate-spin text-base" />
                    ) : (
                      <PiFilePdf className="text-base" />
                    )}
                    {t('manga.downloadPdf')}
                  </button>
                )}
                {chatId && (
                  <Link
                    className="text-aws-smile flex items-center gap-x-1 text-sm hover:underline"
                    to={`/chat/${chatId}`}>
                    <PiChatsCircle className="text-base" />
                    {t('manga.viewInHistory')}
                  </Link>
                )}
              </div>

              {plan && (
                <div className="mb-6 rounded border p-3">
                  <div className="text-lg font-semibold">{plan.title}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {t('manga.plan.pageCount', { n: plan.pages.length })}
                  </div>
                  {plan.characters.length > 0 && (
                    <div className="mt-2">
                      <div className="text-sm font-semibold">
                        {t('manga.plan.characters')}
                      </div>
                      <ul className="ml-4 list-disc text-sm text-gray-600">
                        {plan.characters.map((character, idx) => (
                          <li key={idx}>
                            <span className="font-semibold">
                              {character.name}
                            </span>
                            {character.appearance
                              ? ` — ${character.appearance}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {plan.styleGuide && (
                    <ExpandableField label={t('manga.plan.style')}>
                      <div className="whitespace-pre-wrap break-words text-sm text-gray-600">
                        {plan.styleGuide}
                      </div>
                    </ExpandableField>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-y-8">
                {characterSheet && (
                  <div className="flex flex-col gap-y-2">
                    <div className="text-sm font-semibold">
                      {t('manga.characterSheetTitle')}
                    </div>
                    <div className="relative">
                      <img
                        className="w-full rounded border object-contain"
                        src={characterSheet.signedUrl}
                      />
                      <div className="absolute right-2 top-2">
                        <ButtonIcon
                          className="border bg-white"
                          onClick={() => {
                            downloadImage(
                              characterSheet,
                              'manga-character-sheet.png'
                            );
                          }}
                          title={t('manga.download')}>
                          <PiDownload className="text-aws-smile text-base" />
                        </ButtonIcon>
                      </div>
                    </div>
                  </div>
                )}

                {pages.map((page) => {
                  const pagePlan = plan?.pages.find(
                    (p) => p.pageNumber === page.pageNumber
                  );
                  return (
                    <div
                      key={page.pageNumber}
                      className="flex flex-col gap-y-2">
                      <div className="text-sm font-semibold">
                        {t('manga.page.label', { n: page.pageNumber })}
                        {page.summary && (
                          <span className="ml-2 font-normal text-gray-500">
                            {page.summary}
                          </span>
                        )}
                      </div>
                      <div className="relative">
                        <img
                          className="w-full rounded border object-contain"
                          src={page.image.signedUrl}
                        />
                        {regeneratingPage === page.pageNumber && (
                          <div className="absolute inset-0 flex items-center justify-center rounded bg-white/70">
                            <PiArrowClockwise className="h-12 w-12 animate-spin text-gray-400" />
                          </div>
                        )}
                        <div className="absolute right-2 top-2 flex flex-col gap-y-2">
                          <ButtonIcon
                            className="border bg-white"
                            onClick={() => {
                              downloadImage(
                                page.image,
                                `manga-page-${page.pageNumber}.png`
                              );
                            }}
                            title={t('manga.download')}>
                            <PiDownload className="text-aws-smile text-base" />
                          </ButtonIcon>
                          {pagePlan && (
                            <ButtonIcon
                              className="border bg-white"
                              disabled={busy}
                              onClick={() => {
                                regeneratePage(pagePlan);
                              }}
                              title={t('manga.regenerate')}>
                              <PiArrowClockwise className="text-aws-smile text-base" />
                            </ButtonIcon>
                          )}
                        </div>
                      </div>
                      {pagePlan && (
                        <ExpandableField label={t('manga.page.panels')}>
                          <ul className="ml-4 list-decimal text-sm text-gray-600">
                            {pagePlan.panels.map((panel, idx) => (
                              <li key={idx}>
                                {panel.layout ? `[${panel.layout}] ` : ''}
                                {panel.description}
                                {panel.dialogue.map((dialogue, dIdx) => {
                                  const line = dialogue.speaker
                                    ? `${dialogue.speaker}: ${dialogue.text}`
                                    : dialogue.text;
                                  return (
                                    <div key={dIdx} className="ml-2">
                                      {line}
                                    </div>
                                  );
                                })}
                              </li>
                            ))}
                          </ul>
                        </ExpandableField>
                      )}
                    </div>
                  );
                })}

                {isRunning && (
                  <div className="flex flex-col items-center gap-y-2 py-8 text-gray-400">
                    <PiArrowClockwise className="h-12 w-12 animate-spin" />
                    {status || t('manga.status.planning')}
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
        onSelect={(context) => {
          setChatContext(context);
        }}
      />
    </div>
  );
};

export default GenerateMangaPage;
