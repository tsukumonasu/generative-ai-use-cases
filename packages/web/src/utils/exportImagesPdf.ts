// Fork custom: bundle multiple generated images into a single PDF
// (one image per page, each page sized to the image itself)
import { jsPDF } from 'jspdf';

type PdfPageImage = {
  dataUrl: string;
  format: 'PNG' | 'JPEG';
  width: number;
  height: number;
};

const loadImageElement = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
};

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const toPdfPageImage = async (blob: Blob): Promise<PdfPageImage> => {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(objectUrl);
    const width = img.naturalWidth;
    const height = img.naturalHeight;

    if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
      return {
        dataUrl: await blobToDataUrl(blob),
        format: blob.type === 'image/png' ? 'PNG' : 'JPEG',
        width,
        height,
      };
    }

    // Other formats (e.g. WebP): re-encode as PNG, which jsPDF supports
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      format: 'PNG',
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const exportImagesToPdf = async (
  blobs: Blob[],
  filename: string
): Promise<void> => {
  if (blobs.length === 0) {
    return;
  }

  let doc: jsPDF | undefined;
  for (const blob of blobs) {
    const page = await toPdfPageImage(blob);
    const orientation = page.width >= page.height ? 'landscape' : 'portrait';
    if (!doc) {
      doc = new jsPDF({
        orientation,
        unit: 'px',
        format: [page.width, page.height],
        hotfixes: ['px_scaling'],
      });
    } else {
      doc.addPage([page.width, page.height], orientation);
    }
    doc.addImage(page.dataUrl, page.format, 0, 0, page.width, page.height);
  }

  doc!.save(filename);
};
