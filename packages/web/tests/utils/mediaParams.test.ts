import { describe, expect, it } from 'vitest';
import {
  clampGeminiVideoDuration,
  geminiImageAspectRatios,
  geminiImageThinkingLevels,
  geminiVideoDurations,
  gptImageOutputFormats,
  gptImageQualities,
  gptImageSizes,
} from '@generative-ai-use-cases/common';

describe('media generation parameters', () => {
  it('offers 3 to 15 seconds, and 10 at most with Omni 1.1', () => {
    const current = geminiVideoDurations('gemini-omni-1.2-flash');
    expect(current[0]).toBe(3);
    expect(current[current.length - 1]).toBe(15);
    expect(geminiVideoDurations('gemini-omni-1.1-flash').pop()).toBe(10);
    // A model the table does not know gets the current range
    expect(geminiVideoDurations('').pop()).toBe(15);
  });

  it('clamps a duration to what the model accepts', () => {
    expect(clampGeminiVideoDuration('gemini-omni-1.2-flash', 60)).toBe(15);
    expect(clampGeminiVideoDuration('gemini-omni-1.1-flash', 15)).toBe(10);
    expect(clampGeminiVideoDuration('gemini-omni-1.2-flash', 0)).toBe(3);
    expect(clampGeminiVideoDuration('gemini-omni-1.2-flash', 7.4)).toBe(7);
  });

  it('offers the banner ratios and thinking levels per model', () => {
    expect(geminiImageAspectRatios('gemini-nano-banana-2.1')).toContain('8:1');
    expect(geminiImageAspectRatios('gemini-3-pro-image')).not.toContain('8:1');
    expect(geminiImageThinkingLevels('gemini-nano-banana-2.1')).toContain(
      'medium'
    );
    expect(geminiImageThinkingLevels('gemini-3-pro-image')).toEqual([]);
  });

  it('offers free sizes and the top qualities only where documented', () => {
    expect(gptImageSizes('gpt-image-2')).toContain('3840x2160');
    expect(gptImageSizes('gpt-image-2.6-sunburst')).not.toContain('3840x2160');
    expect(gptImageQualities('gpt-image-2.5-sunburst')).toContain('max');
    expect(gptImageQualities('gpt-image-2.6-sunburst')).not.toContain('max');
  });

  it('keeps a transparent background to formats with an alpha channel', () => {
    expect(gptImageOutputFormats('auto')).toContain('gif');
    expect(gptImageOutputFormats('transparent')).toEqual(['png', 'webp']);
  });
});
