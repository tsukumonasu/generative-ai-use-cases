// Finding the files created by the office-documents runtime
// tools (lambda-python/generic-agent-core-runtime/src/documents) in an answer.
// Each file's PDF and preview pages share its S3 key base:
//   agentcore/<trace>/<uuid>.docx, <uuid>.pdf, <uuid>.page-01.png, ...

// A created file's URL. Groups: the key base, then the extension.
const FILE_URL = String.raw`(https:\/\/[^\s)\]]+?\.amazonaws\.com\/agentcore\/[^\s)\]#?]+?\/[0-9a-f]{32})\.(pptx|docx|xlsx|pdf)`;
// [name](url) -- groups: name, key base, extension
const MARKDOWN_LINK_RE = new RegExp(
  String.raw`\[([^\]]+)\]\(` + FILE_URL,
  'gi'
);
// A bare URL (not the target of a Markdown link) -- groups: key base, extension
const BARE_URL_RE = new RegExp(String.raw`(?<![(\w/])` + FILE_URL, 'gi');

// Same limit as MAX_PREVIEW_PAGES in the runtime (common.py)
export const MAX_PREVIEW_PAGES = 20;

export type GeneratedFile = {
  name: string;
  url: string;
  keyBase: string;
  extension: string;
};

/**
 * The created files linked in an answer, one per file (an Office file and
 * its PDF share their pages, so the Office file wins)
 */
export const findGeneratedFiles = (content: string): GeneratedFile[] => {
  const found = [
    ...[...content.matchAll(MARKDOWN_LINK_RE)].map(
      ([, name, keyBase, ext]) => ({ name, keyBase, ext })
    ),
    ...[...content.matchAll(BARE_URL_RE)].map(([, keyBase, ext]) => ({
      name: undefined,
      keyBase,
      ext,
    })),
  ];
  const files = new Map<string, GeneratedFile>();
  for (const { name, keyBase, ext } of found) {
    const extension = ext.toLowerCase();
    const existing = files.get(keyBase);
    if (!existing || existing.extension === 'pdf') {
      files.set(keyBase, {
        name: name ?? `file.${extension}`,
        url: `${keyBase}.${extension}`,
        keyBase,
        extension,
      });
    }
  }
  return [...files.values()];
};

export const previewPageUrl = (keyBase: string, page: number) =>
  `${keyBase}.page-${String(page).padStart(2, '0')}.png`;
