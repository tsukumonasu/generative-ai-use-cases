// LLM-planned manga generation.
// A text model reads the scenario (free text and/or a referenced chat
// conversation), decides the page count and the panel layout of each page,
// writes the dialogue, and pins down a visual description of every character
// so the image model can keep them consistent across pages.
//
// Each page is then rendered as ONE image (panel borders, speech bubbles and
// lettering all drawn by the image model), with the character reference sheet
// and the previous page passed as reference images.
import { Model, UnrecordedMessage } from 'generative-ai-use-cases';
import {
  PredictStreamFn,
  collectPredictStreamText,
  parseJsonObject,
} from './predictStreamText';
import { extractConversation } from './imagePlanner';

export const MAX_MANGA_PAGES = 16;
export const MAX_PANELS_PER_PAGE = 8;

export type MangaReadingDirection = 'rtl' | 'ltr';

export type MangaCharacter = {
  name: string;
  // Fixed visual description — the single most important field for keeping
  // the character identical across pages
  appearance: string;
};

// A photo of a real person uploaded by the user, to be turned into one of the
// characters. Shown to the planner model (so it can write an "appearance" that
// matches the person) and passed to the image model as a reference image.
export type MangaCastPhoto = {
  // Name the character is called by in the story
  name: string;
  // Optional note from the user (role, personality, ...)
  note?: string;
  // Base64 image data without the data URI prefix (planner call only)
  data: string;
  mediaType: string;
};

// What an image attached to an image-model call is, in attachment order
export type MangaImageReference =
  | { kind: 'characterSheet' }
  | { kind: 'previousPage' }
  | { kind: 'castPhoto'; name: string };

export type MangaDialogue = {
  speaker?: string;
  text: string;
};

export type MangaPanel = {
  panel: number;
  // Where the panel sits on the page and its rough shape
  layout: string;
  description: string;
  dialogue: MangaDialogue[];
  caption?: string;
  sfx?: string;
};

export type MangaPagePlan = {
  pageNumber: number;
  summary: string;
  panels: MangaPanel[];
};

export type MangaPlan = {
  title: string;
  // Art-style directions shared by every page (in English, for the image model)
  styleGuide: string;
  characters: MangaCharacter[];
  pages: MangaPagePlan[];
};

// ---------- Planning ----------

const buildPlanMessages = (params: {
  scenario: string;
  conversation?: string;
  style: string;
  pageCount?: number;
  readingDirection: MangaReadingDirection;
  // Photos are attached to the user message in this order
  castPhotos: MangaCastPhoto[];
}): UnrecordedMessage[] => {
  const {
    scenario,
    conversation,
    style,
    pageCount,
    readingDirection,
    castPhotos,
  } = params;

  return [
    {
      role: 'system',
      content: [
        'You are a professional manga editor and storyboard (name) artist.',
        'You turn source material into a page-by-page manga storyboard: page count, panel layout of every page, dialogue, and a fixed visual description of every character.',
        'Respond with a single JSON object only — no explanations, no code fences.',
      ].join('\n'),
    },
    {
      role: 'user',
      ...(castPhotos.length > 0
        ? {
            extraData: castPhotos.map((photo, index) => ({
              type: 'image' as const,
              name: `cast-photo-${index + 1}.jpg`,
              source: {
                type: 'base64' as const,
                mediaType: photo.mediaType,
                data: photo.data,
              },
            })),
          }
        : {}),
      content: [
        ...(castPhotos.length > 0
          ? [
              'Photographs of real people who must appear as characters are attached to this message, in this order:',
              ...castPhotos.map(
                (photo, index) =>
                  `- Photo ${index + 1}: ${photo.name}${
                    photo.note ? ` — ${photo.note}` : ''
                  }`
              ),
              '',
            ]
          : []),
        ...(conversation
          ? [
              'Source material — a conversation between a user and an AI assistant:',
              '<conversation>',
              conversation,
              '</conversation>',
              '',
            ]
          : []),
        ...(scenario
          ? [
              "The user's scenario and instructions (may include story, tone, characters, and requirements — follow them):",
              '<scenario>',
              scenario,
              '</scenario>',
              '',
            ]
          : []),
        `Requested art style / taste: ${style}`,
        `Reading direction: ${
          readingDirection === 'rtl'
            ? 'right-to-left (Japanese manga convention)'
            : 'left-to-right (Western comic convention)'
        }`,
        '',
        'Rules:',
        pageCount
          ? `- Produce exactly ${pageCount} page(s).`
          : `- Decide the most appropriate number of pages, between 1 and ${MAX_MANGA_PAGES}, for the story to work as a complete piece with a beginning and an ending. Never exceed ${MAX_MANGA_PAGES}.`,
        `- Give each page 1 to ${MAX_PANELS_PER_PAGE} panels (4 to 6 is typical). Vary panel sizes and shapes for rhythm; give climactic moments a large panel.`,
        '- "layout" describes where the panel sits on the page and its shape, e.g. "top row, wide horizontal panel spanning the full width" or "bottom-left, tall vertical panel". Number the panels in reading order.',
        ...(castPhotos.length > 0
          ? [
              `- Every person in the attached photos must appear in the story, listed in "characters" under exactly the name given above (${castPhotos
                .map((photo) => photo.name)
                .join(
                  ', '
                )}). Look at their photo and write their "appearance" from what you actually see: apparent age, gender presentation, hair colour/length/style, glasses, facial features, build, and the clothes they wear in the photo. Describe them as a manga character drawn in the requested style — never as a photograph — and never invent features that contradict the photo.`,
              '- You may add other characters if the story needs them, but the people in the photos are the main cast.',
            ]
          : []),
        '- Every character that appears must be listed in "characters" with an "appearance" that fully pins down their look: apparent age, gender presentation, hair colour/length/style, eye colour, body build, exact clothing, accessories, and any distinguishing feature. This description is reused verbatim on every page, so it must never rely on context and must never change.',
        '- Keep dialogue short enough to fit a speech bubble (roughly 30 characters or fewer per bubble). Use "caption" for narration boxes and "sfx" for sound effects.',
        '- Write "title", "summary", dialogue, captions and sfx in the same language as the source material. Write "styleGuide", "layout", "description" and "appearance" in English (they are fed to the image model).',
        '- "styleGuide" describes the shared art style in one dense paragraph: medium, line work, screentone/shading, colour or black-and-white, level of detail — incorporating the requested taste above.',
        '- Base the story on the source material. Do not invent facts that contradict it.',
        '',
        'Output format:',
        JSON.stringify(
          {
            title: 'title of the manga',
            styleGuide: 'shared art style directions in English',
            characters: [
              {
                name: 'name',
                appearance: 'fixed visual description in English',
              },
            ],
            pages: [
              {
                pageNumber: 1,
                summary: 'what happens on this page',
                panels: [
                  {
                    panel: 1,
                    layout: 'position and shape of the panel on the page',
                    description: 'what is drawn in this panel, in English',
                    dialogue: [{ speaker: 'name', text: 'line' }],
                    caption: 'narration box text (optional)',
                    sfx: 'sound effect text (optional)',
                  },
                ],
              },
            ],
          },
          null,
          2
        ),
      ].join('\n'),
    },
  ];
};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeDialogue = (value: unknown): MangaDialogue[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): MangaDialogue => {
      // Tolerate a bare string instead of {speaker, text}
      if (typeof entry === 'string') return { text: entry.trim() };
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        speaker: asString(record.speaker) || undefined,
        text: asString(record.text),
      };
    })
    .filter((d) => d.text.length > 0);
};

const normalizePanels = (value: unknown): MangaPanel[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PANELS_PER_PAGE).map((entry, index): MangaPanel => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      panel: typeof record.panel === 'number' ? record.panel : index + 1,
      layout: asString(record.layout),
      description: asString(record.description),
      dialogue: normalizeDialogue(record.dialogue),
      caption: asString(record.caption) || undefined,
      sfx: asString(record.sfx) || undefined,
    };
  });
};

const normalizePlan = (parsed: Record<string, unknown>): MangaPlan => {
  const characters = (Array.isArray(parsed.characters) ? parsed.characters : [])
    .map((entry): MangaCharacter => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        name: asString(record.name),
        appearance: asString(record.appearance),
      };
    })
    .filter((c) => c.name.length > 0 || c.appearance.length > 0);

  const pages = (Array.isArray(parsed.pages) ? parsed.pages : [])
    .slice(0, MAX_MANGA_PAGES)
    .map((entry, index): MangaPagePlan => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        pageNumber:
          typeof record.pageNumber === 'number' ? record.pageNumber : index + 1,
        summary: asString(record.summary),
        panels: normalizePanels(record.panels),
      };
    })
    .filter((page) => page.panels.length > 0);

  if (pages.length === 0) {
    throw new Error('Plan response contained no manga pages');
  }

  return {
    title: asString(parsed.title),
    styleGuide: asString(parsed.styleGuide),
    characters,
    pages,
  };
};

// Ask the selected text model to storyboard the manga. Uses predictStream
// (direct Lambda invoke) instead of the buffered predict API — a multi-page
// plan easily exceeds the 29s API Gateway timeout.
export const planManga = async (
  predictStream: PredictStreamFn,
  model: Model,
  params: {
    // Free-text scenario and instructions (may be empty when a chat is used)
    scenario: string;
    // Framed transcript of a referenced chat (ImageChatContext.transcript)
    framedTranscript?: string;
    // Requested art style / taste
    style: string;
    // Fixed page count, or undefined to let the model decide
    pageCount?: number;
    readingDirection: MangaReadingDirection;
    // Photos of real people to cast as characters (requires a vision model)
    castPhotos?: MangaCastPhoto[];
  }
): Promise<MangaPlan> => {
  const text = await collectPredictStreamText(
    predictStream,
    model,
    buildPlanMessages({
      scenario: params.scenario.trim(),
      conversation: params.framedTranscript
        ? extractConversation(params.framedTranscript)
        : undefined,
      style: params.style,
      pageCount: params.pageCount,
      readingDirection: params.readingDirection,
      castPhotos: params.castPhotos ?? [],
    }),
    '/manga-plan'
  );
  return normalizePlan(parseJsonObject<Record<string, unknown>>(text));
};

// ---------- Image prompts ----------

const characterLines = (plan: MangaPlan): string[] =>
  plan.characters.map((c) => `- ${c.name}: ${c.appearance}`);

// Lines describing what each attached image is, in attachment order
const referenceLines = (references: MangaImageReference[]): string[] =>
  references.map((reference, index) => {
    const label = `Attached image ${index + 1}`;
    switch (reference.kind) {
      case 'characterSheet':
        return `- ${label}: the character model sheet of this manga.`;
      case 'previousPage':
        return `- ${label}: the previous page of this manga.`;
      case 'castPhoto':
        return `- ${label}: a photograph of the real person the character "${reference.name}" is based on.`;
    }
  });

const hasCastPhoto = (references: MangaImageReference[]): boolean =>
  references.some((reference) => reference.kind === 'castPhoto');

// One reference sheet drawn up front and passed as a reference image to every
// page, so the characters do not drift as the story progresses.
// Photos of the real people cast as characters (if any) are attached to this
// call, so the likeness is baked into the sheet and inherited by every page.
export const buildCharacterSheetPrompt = (
  plan: MangaPlan,
  references: MangaImageReference[] = []
): string =>
  [
    'Draw a character reference sheet as a single image.',
    ...(references.length > 0
      ? [
          'Reference material attached to this request:',
          ...referenceLines(references),
          ...(hasCastPhoto(references)
            ? [
                'Redraw each photographed person as a manga character in the art style below, keeping their likeness clearly recognisable — face shape, hairstyle, hair colour, glasses, facial hair and other distinguishing features. Never paste, trace or photo-realistically reproduce the photograph itself, and do not include the photo background.',
              ]
            : []),
        ]
      : []),
    `Art style: ${plan.styleGuide}`,
    'Show every character below full-body, standing side by side in a row, front view, neutral pose, on a plain white background, with the character name lettered underneath each of them.',
    'Characters:',
    ...characterLines(plan),
    'This is a model sheet, not a story page: no panel borders, no speech bubbles, no background scenery, no action.',
  ].join('\n');

const panelLines = (panel: MangaPanel): string[] => {
  const lines = [
    `Panel ${panel.panel}${panel.layout ? ` (${panel.layout})` : ''}: ${panel.description}`,
  ];
  for (const dialogue of panel.dialogue) {
    lines.push(
      `  Speech bubble${dialogue.speaker ? ` from ${dialogue.speaker}` : ''}: "${dialogue.text}"`
    );
  }
  if (panel.caption) {
    lines.push(`  Narration box: "${panel.caption}"`);
  }
  if (panel.sfx) {
    lines.push(`  Sound effect lettering: "${panel.sfx}"`);
  }
  return lines;
};

export const buildMangaPagePrompt = (
  plan: MangaPlan,
  page: MangaPagePlan,
  options: {
    readingDirection: MangaReadingDirection;
    // Reference images attached to the call, in attachment order
    references: MangaImageReference[];
  }
): string => {
  const { readingDirection, references } = options;

  return [
    `Draw ONE complete manga page as a single image — page ${page.pageNumber} of ${plan.pages.length} of "${plan.title}".`,
    ...(references.length > 0
      ? [
          'The attached images are reference material for character design and art style ONLY:',
          ...referenceLines(references),
          'Reuse the exact same characters — same faces, hairstyles, costumes, colours and proportions — and the exact same art style.',
          ...(hasCastPhoto(references)
            ? [
                'Draw the photographed people as manga characters that keep their likeness recognisable; never paste or trace the photograph itself.',
              ]
            : []),
          'Do NOT copy the layout of the attached images and do NOT retouch them: compose a brand-new page from the panel list below.',
        ]
      : []),
    `Art style: ${plan.styleGuide}`,
    'Characters (keep these designs exactly):',
    ...characterLines(plan),
    ...(page.summary ? [`This page: ${page.summary}`] : []),
    `Panel layout — draw all ${page.panels.length} panel(s) on this single page, with clear black panel borders and white gutters, arranged ${
      readingDirection === 'rtl'
        ? 'so they read right-to-left and top-to-bottom (Japanese manga convention: panel 1 is at the top right)'
        : 'so they read left-to-right and top-to-bottom (Western comic convention: panel 1 is at the top left)'
    }:`,
    ...page.panels.flatMap(panelLines),
    'Rendering rules:',
    '- Letter every speech bubble, narration box and sound effect exactly as written above, spelled correctly and legibly.',
    ...(readingDirection === 'rtl'
      ? [
          '- Japanese text inside speech bubbles is lettered vertically, top-to-bottom.',
        ]
      : []),
    '- Do not add any text that is not listed above. No page numbers, no watermarks, no signature, no borders around the page itself.',
    '- Fit the whole page inside the frame with a small white margin; never crop a panel.',
  ].join('\n');
};
