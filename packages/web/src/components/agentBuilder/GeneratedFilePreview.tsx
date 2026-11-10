import React, {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, Transition } from '@headlessui/react';
import {
  PiCaretLeft,
  PiCaretRight,
  PiDownloadSimple,
  PiFilePdf,
  PiMicrosoftExcelLogo,
  PiMicrosoftPowerpointLogo,
  PiMicrosoftWordLogo,
  PiX,
} from 'react-icons/pi';
import useFileApi from '../../hooks/useFileApi';
import useRagFile from '../../hooks/useRagFile';
import {
  GeneratedFile,
  MAX_PREVIEW_PAGES,
  previewPageUrl,
} from '../../utils/generatedFiles';

// Preview of a file created by the office-documents runtime tools
// (lambda-python/generic-agent-core-runtime/src/documents). Next to each file
// the runtime uploads its pages as images under the same key base:
//   agentcore/<trace>/<uuid>.docx  ->  agentcore/<trace>/<uuid>.page-01.png, ...
// Images rather than an embedded PDF, because the CSP only allows frames from
// the app itself; and the bucket has no CORS, so the pages are found by
// loading them as images until one is missing.

const loadImage = (src: string) =>
  new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });

const FileIcon: React.FC<{ extension: string }> = ({ extension }) => {
  switch (extension) {
    case 'pptx':
      return <PiMicrosoftPowerpointLogo className="text-orange-600" />;
    case 'xlsx':
      return <PiMicrosoftExcelLogo className="text-green-700" />;
    case 'docx':
      return <PiMicrosoftWordLogo className="text-blue-700" />;
    default:
      return <PiFilePdf className="text-red-600" />;
  }
};

const GeneratedFilePreview: React.FC<{ file: GeneratedFile }> = ({ file }) => {
  const { t } = useTranslation();
  const { getFileDownloadSignedUrl } = useFileApi();
  const { downloadDoc, downloading } = useRagFile();
  // Signed URLs of the pages found so far, in order
  const [pages, setPages] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setDone(false);
    (async () => {
      for (let page = 1; page <= MAX_PREVIEW_PAGES && !cancelled; page++) {
        let signed: string;
        try {
          signed = await getFileDownloadSignedUrl(
            previewPageUrl(file.keyBase, page)
          );
        } catch {
          break;
        }
        if (cancelled || !(await loadImage(signed))) break;
        setPages((current) => [...current, signed]);
      }
      if (!cancelled) setDone(true);
    })();
    return () => {
      cancelled = true;
    };
    // getFileDownloadSignedUrl is a new function on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.keyBase]);

  // Signed URLs expire after 60 seconds; a page the browser no longer has
  // cached is signed again (once, so a missing page cannot loop)
  const resigned = useRef(new Set<number>());
  const resign = useCallback(
    async (index: number) => {
      if (resigned.current.has(index)) return;
      resigned.current.add(index);
      try {
        const signed = await getFileDownloadSignedUrl(
          previewPageUrl(file.keyBase, index + 1)
        );
        setPages((current) =>
          current.map((url, i) => (i === index ? signed : url))
        );
      } catch {
        // Leave the broken image
      }
    },
    [file.keyBase, getFileDownloadSignedUrl]
  );

  const download = () => {
    if (!downloading) downloadDoc(file.url);
  };

  // No preview pages (e.g. Google not linked): the link in the answer is enough
  if (pages.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm print:hidden">
      <div className="mb-2 flex items-center gap-2">
        <span className="shrink-0 text-xl">
          <FileIcon extension={file.extension} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700">
          {file.name}
        </span>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className="flex shrink-0 items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          <PiDownloadSimple />
          {t('agent_builder.file_preview.download')}
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {pages.map((src, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setViewing(index)}
            title={t('agent_builder.file_preview.page', {
              page: index + 1,
              total: pages.length,
            })}
            className="hover:border-aws-smile shrink-0 rounded border border-gray-200 bg-gray-50 p-0.5">
            <img
              src={src}
              onError={() => resign(index)}
              className="h-36 w-auto"
              alt=""
            />
          </button>
        ))}
      </div>
      {done && pages.length === MAX_PREVIEW_PAGES && (
        <p className="mt-1 text-xs text-gray-500">
          {t('agent_builder.file_preview.truncated', {
            count: MAX_PREVIEW_PAGES,
          })}
        </p>
      )}

      <Transition appear show={viewing !== null} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-50"
          onClose={() => setViewing(null)}>
          <div className="fixed inset-0 bg-black/60" />
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <Dialog.Panel className="flex max-h-full w-full max-w-6xl flex-col rounded-lg bg-white p-3 shadow-xl">
              <div className="mb-2 flex items-center gap-2">
                <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700">
                  {file.name}
                </Dialog.Title>
                <button
                  type="button"
                  onClick={download}
                  disabled={downloading}
                  className="flex shrink-0 items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  <PiDownloadSimple />
                  {t('agent_builder.file_preview.download')}
                </button>
                <button
                  type="button"
                  onClick={() => setViewing(null)}
                  title={t('agent_builder.file_preview.close')}
                  className="rounded p-1 text-xl text-gray-500 hover:bg-gray-100">
                  <PiX />
                </button>
              </div>
              {viewing !== null && (
                <div className="flex min-h-0 flex-1 items-center gap-2">
                  <button
                    type="button"
                    disabled={viewing === 0}
                    onClick={() => setViewing(viewing - 1)}
                    title={t('agent_builder.file_preview.previous')}
                    className="rounded p-2 text-2xl text-gray-600 hover:bg-gray-100 disabled:opacity-30">
                    <PiCaretLeft />
                  </button>
                  <div className="flex min-h-0 flex-1 justify-center">
                    <img
                      src={pages[viewing]}
                      onError={() => resign(viewing)}
                      className="max-h-[80vh] max-w-full border border-gray-200 object-contain"
                      alt=""
                    />
                  </div>
                  <button
                    type="button"
                    disabled={viewing === pages.length - 1}
                    onClick={() => setViewing(viewing + 1)}
                    title={t('agent_builder.file_preview.next')}
                    className="rounded p-2 text-2xl text-gray-600 hover:bg-gray-100 disabled:opacity-30">
                    <PiCaretRight />
                  </button>
                </div>
              )}
              {viewing !== null && (
                <p className="mt-2 text-center text-xs text-gray-500">
                  {t('agent_builder.file_preview.page', {
                    page: viewing + 1,
                    total: pages.length,
                  })}
                </p>
              )}
            </Dialog.Panel>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
};

export default GeneratedFilePreview;
