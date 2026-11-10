// Fetching / downloading generated media (images, videos) of the
// image / video pages from their permanent S3 URL.
import { useCallback } from 'react';
import { toast } from 'sonner';
import useFileApi from './useFileApi';

const useMediaDownload = () => {
  const { getFileDownloadSignedUrl } = useFileApi();

  // Signed URLs expire after 60 seconds — a fresh one is issued for every
  // fetch, and `res.ok` is checked (an expired URL returns an AccessDenied
  // XML body that would otherwise be saved as if it were the file)
  const fetchBlob = useCallback(
    async (s3Url: string): Promise<Blob> => {
      const signedUrl = await getFileDownloadSignedUrl(s3Url);
      const res = await fetch(signedUrl);
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`);
      }
      return res.blob();
    },
    [getFileDownloadSignedUrl]
  );

  // Save the file through a temporary anchor; a failure is reported with
  // `errorMessage` (already translated by the page)
  const download = useCallback(
    async (s3Url: string, filename: string, errorMessage: string) => {
      try {
        const blob = await fetchBlob(s3Url);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error(e);
        toast.error(errorMessage);
      }
    },
    [fetchBlob]
  );

  return { fetchBlob, download };
};

export default useMediaDownload;
