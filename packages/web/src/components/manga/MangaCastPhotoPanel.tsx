// The cast-photo section of the manga page — photos of real
// people to be drawn as characters, each with a name (required) and a note.
import React, { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { PiArrowClockwise, PiUpload, PiX } from 'react-icons/pi';
import useFileApi from '../../hooks/useFileApi';
import { extractBaseURL } from '../../hooks/useFiles';
import useMangaState, {
  CastPhoto,
  MAX_CAST_PHOTOS,
} from '../../hooks/useMangaState';
import { downscaleImageFile } from '../../utils/imageDownscale';
import ButtonIcon from '../ButtonIcon';
import InputText from '../InputText';

const ACCEPT_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Photos are re-encoded to fit this box before being uploaded / shown to the
// planner — plenty for a portrait, and keeps the invoke payloads small
const CAST_PHOTO_MAX_EDGE = 1024;

type Props = {
  // Upload in progress; owned by the page, which blocks generation meanwhile
  isUploading: boolean;
  onUploadingChange: (uploading: boolean) => void;
  // A photo without a name cannot be cast as a character
  missingName: boolean;
};

const MangaCastPhotoPanel: React.FC<Props> = ({
  isUploading,
  onUploadingChange,
  missingName,
}) => {
  const { t } = useTranslation();
  const { castPhotos, addCastPhotos, updateCastPhoto, removeCastPhoto } =
    useMangaState();
  const { getSignedUrl, uploadFile } = useFileApi();

  // Cast photos are downscaled in the browser, then uploaded to the file
  // bucket: the image model receives them as S3 URLs (resolved server-side),
  // and the planner receives the same bytes inline as base64
  const onChangePhotoFiles = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      // Allow selecting the same file again
      e.target.value = '';
      if (files.length === 0) return;

      const accepted: File[] = [];
      for (const file of files) {
        if (!ACCEPT_PHOTO_TYPES.includes(file.type)) {
          toast.error(t('manga.castPhotos.error.unsupportedFileType'));
          continue;
        }
        if (castPhotos.length + accepted.length >= MAX_CAST_PHOTOS) {
          toast.error(
            t('manga.castPhotos.error.tooMany', { max: MAX_CAST_PHOTOS })
          );
          break;
        }
        accepted.push(file);
      }
      if (accepted.length === 0) return;

      onUploadingChange(true);
      try {
        const uploaded = await Promise.all(
          accepted.map(async (file): Promise<CastPhoto> => {
            const image = await downscaleImageFile(file, CAST_PHOTO_MAX_EDGE);
            // The upload key is prefixed with a UUID server-side, so a fixed
            // (safely encodable) file name is enough
            const signedUrl = (
              await getSignedUrl({
                filename: 'manga-cast-photo.jpg',
                mediaFormat: 'jpg',
              })
            ).data;
            await uploadFile(signedUrl, {
              file: new File([image.blob], 'cast.jpg', {
                type: image.mediaType,
              }),
            });
            return {
              name: '',
              note: '',
              previewUrl: URL.createObjectURL(image.blob),
              // Strip the query string to keep the permanent S3 URL
              s3Url: extractBaseURL(signedUrl),
              data: image.data,
              mediaType: image.mediaType,
            };
          })
        );
        addCastPhotos(uploaded);
      } catch (err) {
        console.error(err);
        toast.error(t('manga.castPhotos.error.uploadFailed'));
      }
      onUploadingChange(false);
    },
    [castPhotos, addCastPhotos, getSignedUrl, uploadFile, onUploadingChange, t]
  );

  return (
    <div>
      <div className="text-sm">{t('manga.castPhotos.label')}</div>

      <label>
        <input
          hidden
          onChange={onChangePhotoFiles}
          type="file"
          accept={ACCEPT_PHOTO_TYPES.join(',')}
          multiple
          disabled={isUploading || castPhotos.length >= MAX_CAST_PHOTOS}
          value={[]}
        />
        <div
          className={`text-aws-smile border-aws-smile my-2 flex w-full flex-row items-center justify-center rounded-full border-2 bg-white p-1 text-sm ${
            isUploading || castPhotos.length >= MAX_CAST_PHOTOS
              ? 'cursor-not-allowed opacity-50'
              : 'cursor-pointer hover:bg-gray-100'
          }`}>
          {isUploading ? (
            <>
              <PiArrowClockwise className="mr-1 animate-spin text-base" />
              {t('manga.castPhotos.uploading')}
            </>
          ) : (
            <>
              <PiUpload className="mr-1 text-base" />
              {t('manga.castPhotos.upload')}
            </>
          )}
        </div>
      </label>

      <p className="my-1 text-xs text-gray-400">
        {t('manga.castPhotos.help', { max: MAX_CAST_PHOTOS })}
      </p>

      {castPhotos.length > 0 && (
        <div className="mt-2 flex flex-col gap-y-2">
          {castPhotos.map((photo, idx) => (
            <div
              key={idx}
              className="flex flex-row items-start gap-x-2 rounded border p-2">
              <img
                className="h-16 w-16 shrink-0 rounded object-cover"
                src={photo.previewUrl}
              />
              <div className="flex grow flex-col gap-y-1">
                <InputText
                  value={photo.name}
                  placeholder={t('manga.castPhotos.namePlaceholder')}
                  onChange={(v) => {
                    updateCastPhoto(idx, { name: v });
                  }}
                />
                <InputText
                  value={photo.note}
                  placeholder={t('manga.castPhotos.notePlaceholder')}
                  onChange={(v) => {
                    updateCastPhoto(idx, { note: v });
                  }}
                />
              </div>
              <ButtonIcon
                onClick={() => {
                  removeCastPhoto(idx);
                }}
                title={t('manga.castPhotos.remove')}>
                <PiX className="text-base" />
              </ButtonIcon>
            </div>
          ))}
        </div>
      )}

      {missingName && (
        <p className="my-1 text-xs text-red-500">
          {t('manga.castPhotos.nameRequired')}
        </p>
      )}
    </div>
  );
};

export default MangaCastPhotoPanel;
