// Downscale an uploaded photo in the browser before it is sent
// anywhere. Cast photos of the manga page travel twice — inline as base64 to
// the planner model (direct Lambda invoke, 6MB payload limit) and as an S3
// upload used as a reference image — so a phone-sized original is trimmed to
// something the models can read without blowing either budget.
export type DownscaledImage = {
  blob: Blob;
  // Base64 payload without the data URI prefix
  data: string;
  mediaType: string;
  width: number;
  height: number;
};

const OUTPUT_MEDIA_TYPE = 'image/jpeg';
const OUTPUT_QUALITY = 0.9;

const loadImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image: ${file.name}`));
    };
    img.src = url;
  });

// Fit the image inside a maxEdge x maxEdge box (never upscales) and re-encode
// it as JPEG
export const downscaleImageFile = async (
  file: File,
  maxEdge: number
): Promise<DownscaledImage> => {
  const img = await loadImage(file);
  const scale = Math.min(
    1,
    maxEdge / Math.max(img.naturalWidth, img.naturalHeight)
  );
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to get a 2d canvas context');
  }
  // JPEG has no alpha — fill transparent areas with white instead of black
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(img, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode the image'))),
      OUTPUT_MEDIA_TYPE,
      OUTPUT_QUALITY
    );
  });

  return {
    blob,
    data: canvas.toDataURL(OUTPUT_MEDIA_TYPE, OUTPUT_QUALITY).split(',')[1],
    mediaType: OUTPUT_MEDIA_TYPE,
    width,
    height,
  };
};
