// State of the manga generation page (pages/GenerateMangaPage.tsx).
// Kept in a zustand store so the settings and the generated manga survive
// navigating away from the page (cleared by a reload or the clear button).
import { create } from 'zustand';
import {
  GeminiImageSize,
  GptImageQuality,
  GptImageSize,
} from 'generative-ai-use-cases';
import { ImageChatContext } from '../utils/chatContext';
import { MangaPlan, MangaReadingDirection } from '../utils/mangaPlanner';

// Art-style directions handed to the planner (and through it to the image
// model). Written in English because the image models follow it best.
export const TASTE_PRESETS: { value: string; style: string }[] = [
  {
    value: 'shonen',
    style:
      'Japanese shonen manga, black and white, bold dynamic ink line work, screentone shading, speed lines, energetic camera angles',
  },
  {
    value: 'shojo',
    style:
      'Japanese shojo manga, black and white, delicate thin line work, large expressive sparkling eyes, floral screentone and soft decorative backgrounds',
  },
  {
    value: 'seinen',
    style:
      'Japanese seinen / gekiga manga, black and white, heavy realistic cross-hatching, gritty detailed backgrounds, restrained cinematic composition',
  },
  {
    value: 'yonkoma',
    style:
      'Japanese 4-koma gag manga, black and white, simple rounded cartoon shapes, deformed comedic expressions, minimal backgrounds',
  },
  {
    value: 'chibi',
    style:
      'cute chibi / super-deformed manga, soft flat colours, thick clean outlines, simple cheerful backgrounds',
  },
  {
    value: 'anime',
    style:
      'modern anime-style full colour illustration, clean cel shading, vivid colours, detailed backgrounds',
  },
  {
    value: 'american',
    style:
      'American comic book, full colour, bold inking, halftone dots, dramatic dynamic rendering',
  },
  {
    value: 'watercolor',
    style:
      'gentle watercolour picture-book illustration, soft washes of colour, hand-drawn pencil outlines',
  },
];

// Photos of real people cast as characters
export const MAX_CAST_PHOTOS = 6;

export type CastPhoto = {
  // Name the character is called by in the story (required)
  name: string;
  // Optional note from the user (role, personality, ...)
  note: string;
  // Object URL of the downscaled photo, used for the thumbnail
  previewUrl: string;
  // Permanent S3 URL, passed to the image model as a reference image
  s3Url: string;
  // Base64 data (no data URI prefix), shown to the planner model
  data: string;
  mediaType: string;
};

export type MangaResultImage = {
  // Permanent S3 URL (a fresh signed URL is issued for every fetch, since
  // signed URLs expire after 60 seconds)
  s3Url: string;
  // Signed URL issued right after generation (used for display)
  signedUrl: string;
};

export type MangaPageResult = {
  pageNumber: number;
  summary: string;
  // The full prompt sent to the image model (shown for transparency / debug)
  prompt: string;
  image: MangaResultImage;
};

type StateType = {
  scenario: string;
  taste: string;
  tasteDetail: string;
  readingDirection: MangaReadingDirection;
  pageCount: string; // 'auto' or a number as string
  aspectRatio: string;
  imageSize: GeminiImageSize;
  gptSize: GptImageSize;
  quality: GptImageQuality;
  useCharacterSheet: boolean;
  // Photos of real people to cast as characters
  castPhotos: CastPhoto[];
  // Existing chat referenced as the scenario source
  chatContext?: ImageChatContext;
  plan?: MangaPlan;
  characterSheet?: MangaResultImage;
  pages: MangaPageResult[];
  // Chat the whole manga is recorded into (one manga = one chat)
  chatId?: string;
  setScenario: (v: string) => void;
  setTaste: (v: string) => void;
  setTasteDetail: (v: string) => void;
  setReadingDirection: (v: MangaReadingDirection) => void;
  setPageCount: (v: string) => void;
  setAspectRatio: (v: string) => void;
  setImageSize: (v: GeminiImageSize) => void;
  setGptSize: (v: GptImageSize) => void;
  setQuality: (v: GptImageQuality) => void;
  setUseCharacterSheet: (v: boolean) => void;
  addCastPhotos: (photos: CastPhoto[]) => void;
  updateCastPhoto: (index: number, patch: Partial<CastPhoto>) => void;
  removeCastPhoto: (index: number) => void;
  setChatContext: (v?: ImageChatContext) => void;
  startPlan: (plan: MangaPlan) => void;
  setCharacterSheet: (image: MangaResultImage, chatId?: string) => void;
  addPage: (page: MangaPageResult, chatId?: string) => void;
  replacePage: (page: MangaPageResult) => void;
  setResults: (
    characterSheet: MangaResultImage | undefined,
    pages: MangaPageResult[]
  ) => void;
  clear: () => void;
};

const useMangaState = create<StateType>((set) => {
  const INIT_STATE = {
    scenario: '',
    taste: TASTE_PRESETS[0].value,
    tasteDetail: '',
    readingDirection: 'rtl' as MangaReadingDirection,
    pageCount: 'auto',
    aspectRatio: '3:4',
    imageSize: '1K' as GeminiImageSize,
    gptSize: '1024x1536' as GptImageSize,
    quality: 'low' as GptImageQuality,
    useCharacterSheet: true,
    castPhotos: [] as CastPhoto[],
    chatContext: undefined,
    plan: undefined,
    characterSheet: undefined,
    pages: [],
    chatId: undefined,
  };
  return {
    ...INIT_STATE,
    setScenario: (v) => set(() => ({ scenario: v })),
    setTaste: (v) => set(() => ({ taste: v })),
    setTasteDetail: (v) => set(() => ({ tasteDetail: v })),
    setReadingDirection: (v) => set(() => ({ readingDirection: v })),
    setPageCount: (v) => set(() => ({ pageCount: v })),
    setAspectRatio: (v) => set(() => ({ aspectRatio: v })),
    setImageSize: (v) => set(() => ({ imageSize: v })),
    setGptSize: (v) => set(() => ({ gptSize: v })),
    setQuality: (v) => set(() => ({ quality: v })),
    setUseCharacterSheet: (v) => set(() => ({ useCharacterSheet: v })),
    addCastPhotos: (photos) =>
      set((state) => ({
        castPhotos: [...state.castPhotos, ...photos].slice(0, MAX_CAST_PHOTOS),
      })),
    updateCastPhoto: (index, patch) =>
      set((state) => ({
        castPhotos: state.castPhotos.map((photo, i) =>
          i === index ? { ...photo, ...patch } : photo
        ),
      })),
    removeCastPhoto: (index) =>
      set((state) => ({
        castPhotos: state.castPhotos.filter((_, i) => i !== index),
      })),
    setChatContext: (v) => set(() => ({ chatContext: v })),
    // A new run replaces the previous manga, including its session chat
    startPlan: (plan) =>
      set(() => ({
        plan,
        characterSheet: undefined,
        pages: [],
        chatId: undefined,
      })),
    setCharacterSheet: (image, chatId) =>
      set((state) => ({
        characterSheet: image,
        chatId: chatId ?? state.chatId,
      })),
    addPage: (page, chatId) =>
      set((state) => ({
        pages: [...state.pages, page],
        // Keep the session chat even if recording failed for one page
        chatId: chatId ?? state.chatId,
      })),
    replacePage: (page) =>
      set((state) => ({
        pages: state.pages.map((p) =>
          p.pageNumber === page.pageNumber ? page : p
        ),
      })),
    setResults: (characterSheet, pages) =>
      set(() => ({ characterSheet, pages })),
    clear: () => set(INIT_STATE),
  };
});

export default useMangaState;
