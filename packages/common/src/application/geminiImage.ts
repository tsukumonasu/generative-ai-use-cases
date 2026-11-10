// Image sizes each Gemini image model (Nano Banana family)
// accepts. The single source for both sides:
//   - the Lambda (packages/cdk/lambda/utils/geminiApi.ts) clamps a requested
//     size to the nearest supported one, to avoid a 400 INVALID_ARGUMENT
//   - the web (packages/web/src/utils/mediaModels.ts) offers only these sizes
//
// A model that is NOT listed here is deliberately treated differently by the
// two sides — keep it that way:
//   - Lambda: the requested size is passed through unchanged (the model is
//     unknown, so there is nothing to clamp to)
//   - web: the selector offers DEFAULT_GEMINI_IMAGE_SIZES (what the current
//     models accept)
//
//   gemini-3.1-flash-lite-image (Nano Banana 2 Lite): 1K only
//   gemini-3.1-flash-image      (Nano Banana 2)     : 512 / 1K / 2K / 4K
//   gemini-nano-banana-2.1      (Nano Banana 2.1)   : 1K / 2K / 4K
//   gemini-3-pro-image          (Nano Banana Pro)   : 1K / 2K / 4K
//   gemini-2.5-flash-image      (Nano Banana)       : 1K only
export const GEMINI_MODEL_IMAGE_SIZES: Record<string, string[]> = {
  'gemini-3.1-flash-lite-image': ['1K'],
  'gemini-3.1-flash-image': ['512', '1K', '2K', '4K'],
  'gemini-nano-banana-2.1': ['1K', '2K', '4K'],
  'gemini-3-pro-image': ['1K', '2K', '4K'],
  'gemini-2.5-flash-image': ['1K'],
};

// Web only: the sizes offered for a model that is not listed above
export const DEFAULT_GEMINI_IMAGE_SIZES: string[] = ['1K', '2K', '4K'];
