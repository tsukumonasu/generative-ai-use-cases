import { pickMediaModel } from '../../../lambda/utils/mediaModel';

const DEFAULT = 'default-model';
const ALLOWED = JSON.stringify(['model-a', 'model-b']);

describe('pickMediaModel', () => {
  test('accepts the default model and the models of the list', () => {
    expect(pickMediaModel(DEFAULT, DEFAULT, ALLOWED)).toBe(DEFAULT);
    expect(pickMediaModel('model-a', DEFAULT, ALLOWED)).toBe('model-a');
    expect(pickMediaModel('model-b', DEFAULT, ALLOWED)).toBe('model-b');
    // The default does not have to be in the list
    expect(pickMediaModel(DEFAULT, DEFAULT, undefined)).toBe(DEFAULT);
  });

  test('replaces a missing or unlisted model with the default', () => {
    for (const requested of [
      undefined,
      '',
      'model-c',
      'MODEL-A',
      'model-a ',
      'model',
      'model-a,model-b',
      ALLOWED,
    ]) {
      expect(pickMediaModel(requested, DEFAULT, ALLOWED)).toBe(DEFAULT);
    }
  });

  test('a list that is missing or not an array of strings allows nothing', () => {
    for (const allowed of [
      undefined,
      '',
      '[]',
      'model-a',
      'not json',
      '"model-a"',
      '{"model-a":true}',
      '[["model-a"]]',
      '[{"id":"model-a"}]',
    ]) {
      expect(pickMediaModel('model-a', DEFAULT, allowed)).toBe(DEFAULT);
    }
  });

  test('ignores the entries of the list that are not strings', () => {
    const mixed = JSON.stringify([1, null, 'model-a']);
    expect(pickMediaModel('model-a', DEFAULT, mixed)).toBe('model-a');
    expect(pickMediaModel('1', DEFAULT, mixed)).toBe(DEFAULT);
  });
});
