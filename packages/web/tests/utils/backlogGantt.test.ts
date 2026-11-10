import { describe, expect, it } from 'vitest';
import { BacklogGanttIssue, BacklogMember } from 'generative-ai-use-cases';
import {
  GANTT_WEEK_OPTIONS,
  MAX_GANTT_PEOPLE,
  addBacklogDays,
  backlogDaysBetween,
  defaultGanttFrom,
  ganttBarPosition,
  ganttDayWidth,
  ganttDays,
  ganttMonths,
  ganttStepWeeks,
  ganttTo,
  groupByAssignee,
  memberMatches,
  mondayOf,
  parseSavedPeople,
} from '../../src/utils/backlogGantt';

// Names and searches as people type them in Japanese
/* eslint-disable i18nhelper/no-jp-string */

const issue = (
  issueKey: string,
  assigneeId: number | undefined,
  assigneeName = ''
): BacklogGanttIssue => ({
  issueKey,
  summary: issueKey,
  url: '',
  projectKey: 'PROJ',
  projectName: 'PROJ',
  issueType: 'Task',
  status: 'Open',
  priority: 'Normal',
  updated: '2026-11-09',
  stalled: false,
  assigneeId,
  assigneeName,
  closed: false,
});

describe('backlogGantt', () => {
  it('counts days across months and years', () => {
    expect(addBacklogDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addBacklogDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(backlogDaysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(backlogDaysBetween('2026-11-09', '2026-11-09')).toBe(0);
  });

  it('starts by default on the Monday of last week', () => {
    // Monday, Sunday, Wednesday
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');
    expect(mondayOf('2027-01-06')).toBe('2027-01-04');
    expect(defaultGanttFrom('2026-11-11')).toBe('2026-11-02');
  });

  it('keeps every period within the server limit', () => {
    expect(ganttTo('2026-11-02', 8)).toBe('2026-12-27');
    for (const weeks of GANTT_WEEK_OPTIONS) {
      expect(weeks * 7).toBeLessThanOrEqual(186);
    }
    expect(ganttStepWeeks(4)).toBe(2);
    expect(ganttStepWeeks(13)).toBe(6);
    expect(ganttStepWeeks(1)).toBe(1);
  });

  it('lists the days with their weekday and the months they fall in', () => {
    const days = ganttDays('2026-11-29', '2026-12-02');
    expect(days).toEqual([
      { date: '2026-11-29', day: 29, weekday: 0 },
      { date: '2026-11-30', day: 30, weekday: 1 },
      { date: '2026-12-01', day: 1, weekday: 2 },
      { date: '2026-12-02', day: 2, weekday: 3 },
    ]);
    expect(ganttMonths(days)).toEqual([
      { date: '2026-11-29', offset: 0, days: 2 },
      { date: '2026-12-01', offset: 2, days: 2 },
    ]);
  });

  it('narrows the days as the period grows', () => {
    const widths = [28, 56, 91, 182].map(ganttDayWidth);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
  });

  it('places a span in the period and tells when it is cut', () => {
    const from = '2026-11-02';
    const to = '2026-11-29';
    expect(
      ganttBarPosition({ start: '2026-11-04', end: '2026-11-06' }, from, to)
    ).toEqual({ offset: 2, length: 3, clippedStart: false, clippedEnd: false });
    expect(
      ganttBarPosition({ start: '2026-10-20', end: '2026-12-10' }, from, to)
    ).toEqual({ offset: 0, length: 28, clippedStart: true, clippedEnd: true });
    expect(
      ganttBarPosition({ start: '2026-10-01', end: '2026-11-01' }, from, to)
    ).toBeNull();
    expect(
      ganttBarPosition({ start: '2026-11-30', end: '2026-12-01' }, from, to)
    ).toBeNull();
  });

  it('groups by person in the order they were added, everyone listed', () => {
    const groups = groupByAssignee(
      [issue('PROJ-1', 88), issue('PROJ-2', 77), issue('PROJ-3', 88)],
      [
        { id: 88, name: 'Hanako' },
        { id: 77, name: 'Taro' },
        { id: 99, name: 'Jiro' },
      ]
    );
    expect(
      groups.map((g) => [g.person.name, g.issues.map((i) => i.issueKey)])
    ).toEqual([
      ['Hanako', ['PROJ-1', 'PROJ-3']],
      ['Taro', ['PROJ-2']],
      ['Jiro', []],
    ]);
  });

  it('keeps an issue of someone else in a group of its own', () => {
    const groups = groupByAssignee(
      [issue('PROJ-1', 55, 'Saburo'), issue('PROJ-2', 55, 'Saburo')],
      [{ id: 77, name: 'Taro' }]
    );
    expect(groups.map((g) => [g.person, g.issues.length])).toEqual([
      [{ id: 77, name: 'Taro' }, 0],
      [{ id: 55, name: 'Saburo' }, 2],
    ]);
  });

  it('finds people by name, login ID or email, loosely', () => {
    const member: BacklogMember = {
      id: 77,
      name: '山田 タロウ',
      userId: 'yamada.t',
      mailAddress: 'Taro.Yamada@example.co.jp',
      projectKeys: ['PROJ'],
    };
    for (const keyword of [
      '',
      '山田',
      '山田タロウ',
      'たろう',
      'ＹＡＭＡＤＡ',
      'taro.yamada@',
    ]) {
      expect(memberMatches(member, keyword)).toBe(true);
    }
    expect(memberMatches(member, 'hanako')).toBe(false);
  });

  it('reads back only well-formed saved people', () => {
    expect(parseSavedPeople('')).toEqual([]);
    expect(parseSavedPeople('{')).toEqual([]);
    expect(parseSavedPeople('{"id":1}')).toEqual([]);
    expect(
      parseSavedPeople(
        JSON.stringify([
          { id: 77, name: 'Taro', extra: true },
          { id: 77, name: 'Taro again' },
          { id: '88', name: 'Hanako' },
          { id: 0, name: 'Nobody' },
          null,
          { id: 99, name: 'Jiro' },
        ])
      )
    ).toEqual([
      { id: 77, name: 'Taro' },
      { id: 99, name: 'Jiro' },
    ]);
    const many = Array.from({ length: MAX_GANTT_PEOPLE + 5 }, (_, i) => ({
      id: i + 1,
      name: `P${i + 1}`,
    }));
    expect(parseSavedPeople(JSON.stringify(many))).toHaveLength(
      MAX_GANTT_PEOPLE
    );
  });
});
