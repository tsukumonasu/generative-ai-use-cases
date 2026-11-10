import { describe, expect, it } from 'vitest';

// Answers are in Japanese, file names included: those are the cases to cover
/* eslint-disable i18nhelper/no-jp-string */
import {
  findGeneratedFiles,
  previewPageUrl,
} from '../../src/utils/generatedFiles';

const base =
  'https://agentcorestack-filebucket-abc.s3.ap-northeast-1.amazonaws.com/agentcore/464fd419-b1af-4539-a798-def66ad04d1f/b2fd0191dd154b1fadf7d6badf2c112c';
const other = base.replace('b2fd0191', 'aaaa0191');

describe('findGeneratedFiles', () => {
  it('finds Markdown links to created files', () => {
    expect(
      findGeneratedFiles(
        `ファイル: [議事録 2026-11-08.docx](${base}.docx)(全3ページ)`
      )
    ).toEqual([
      {
        name: '議事録 2026-11-08.docx',
        url: `${base}.docx`,
        keyBase: base,
        extension: 'docx',
      },
    ]);
  });

  it('lists a file and its PDF once, as the Office file', () => {
    const files = findGeneratedFiles(
      `[報告.pdf](${base}.pdf) と [報告.pptx](${base}.pptx)`
    );
    expect(files).toHaveLength(1);
    expect(files[0].extension).toBe('pptx');
  });

  it('finds bare URLs too', () => {
    expect(findGeneratedFiles(`こちら: ${other}.xlsx`)).toEqual([
      {
        name: 'file.xlsx',
        url: `${other}.xlsx`,
        keyBase: other,
        extension: 'xlsx',
      },
    ]);
  });

  it('ignores preview images and other links', () => {
    expect(
      findGeneratedFiles(
        `![p1](${base}.page-01.png) [Drive](https://docs.google.com/document/d/abc) [x](${base}.png)`
      )
    ).toEqual([]);
  });
});

describe('previewPageUrl', () => {
  it('numbers pages with two digits', () => {
    expect(previewPageUrl(base, 3)).toBe(`${base}.page-03.png`);
  });
});
