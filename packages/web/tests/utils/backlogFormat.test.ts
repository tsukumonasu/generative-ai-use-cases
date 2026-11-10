import { describe, expect, it } from 'vitest';
import {
  backlogDaysBefore,
  formatBacklogDate,
  groupByProject,
} from '../../src/utils/backlogFormat';

describe('backlogFormat', () => {
  it('counts days back across months and years', () => {
    expect(backlogDaysBefore('2026-11-08', 7)).toBe('2026-11-01');
    expect(backlogDaysBefore('2027-01-03', 7)).toBe('2026-12-27');
  });

  it('shows a Backlog day as that day in any time zone', () => {
    expect(formatBacklogDate('2026-11-08', 'en-US')).toBe('Sun, 11/8');
  });

  it('groups by project in key order, keeping the item order', () => {
    const groups = groupByProject([
      { key: 'INFRA-2', projectKey: 'INFRA', projectName: 'Infra' },
      { key: 'APP-9', projectKey: 'APP', projectName: '' },
      { key: 'INFRA-1', projectKey: 'INFRA', projectName: 'Infra' },
    ]);
    expect(
      groups.map((g) => [
        g.projectKey,
        g.projectName,
        g.items.map((i) => i.key),
      ])
    ).toEqual([
      ['APP', 'APP', ['APP-9']],
      ['INFRA', 'Infra', ['INFRA-2', 'INFRA-1']],
    ]);
  });
});
