// Date math and grouping of the Backlog gantt chart
// (components/backlog/BacklogGanttView.tsx). Days are YYYY-MM-DD in Japan,
// computed in UTC so that the browser's time zone does not shift them.
import { BacklogGanttIssue, BacklogMember } from 'generative-ai-use-cases';

// The server accepts at most this many people at a time
export const MAX_GANTT_PEOPLE = 20;

// Lengths of the period the user can pick, in weeks (the longest stays
// within the server's limit of 186 days)
export const GANTT_WEEK_OPTIONS = [4, 8, 13, 26];
export const DEFAULT_GANTT_WEEKS = 8;

const DAY_MS = 86_400_000;

const toTime = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export const addBacklogDays = (date: string, days: number): string =>
  new Date(toTime(date) + days * DAY_MS).toISOString().slice(0, 10);

/** Days from `from` to `to`; 0 for the same day. */
export const backlogDaysBetween = (from: string, to: string): number =>
  Math.round((toTime(to) - toTime(from)) / DAY_MS);

/** The Monday of the week of `date`. */
export const mondayOf = (date: string): string => {
  // 0 = Sunday
  const dayOfWeek = new Date(toTime(date)).getUTCDay();
  return addBacklogDays(date, -((dayOfWeek + 6) % 7));
};

/** Where the chart starts by default: the Monday of last week. */
export const defaultGanttFrom = (today: string): string =>
  addBacklogDays(mondayOf(today), -7);

/** The last day of a period of `weeks` weeks starting on `from`. */
export const ganttTo = (from: string, weeks: number): string =>
  addBacklogDays(from, weeks * 7 - 1);

/** How far the previous / next buttons move: half the period, in weeks. */
export const ganttStepWeeks = (weeks: number): number =>
  Math.max(1, Math.floor(weeks / 2));

export type GanttDay = {
  date: string;
  // 1 to 31
  day: number;
  // 0 = Sunday
  weekday: number;
};

export const ganttDays = (from: string, to: string): GanttDay[] => {
  const count = backlogDaysBetween(from, to) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const date = addBacklogDays(from, index);
    const d = new Date(toTime(date));
    return { date, day: d.getUTCDate(), weekday: d.getUTCDay() };
  });
};

/** Pixels per day, so that a longer period still fits a screen or two. */
export const ganttDayWidth = (days: number): number => {
  if (days <= 28) return 32;
  if (days <= 56) return 20;
  if (days <= 91) return 12;
  return 6;
};

export type GanttMonth = {
  // YYYY-MM-01 (or the first day of the period)
  date: string;
  // Index of its first day in the period
  offset: number;
  days: number;
};

/** The months the period covers, each with where it starts and its days. */
export const ganttMonths = (days: GanttDay[]): GanttMonth[] => {
  const months: GanttMonth[] = [];
  days.forEach((day, index) => {
    const last = months[months.length - 1];
    if (!last || day.day === 1) {
      months.push({ date: day.date, offset: index, days: 1 });
    } else {
      last.days += 1;
    }
  });
  return months;
};

export type GanttBarPosition = {
  // Index of the first day drawn, and the number of days
  offset: number;
  length: number;
  // The span goes on before / after the period
  clippedStart: boolean;
  clippedEnd: boolean;
};

/** Where a span sits in the period; null when it is outside. */
export const ganttBarPosition = (
  span: { start: string; end: string },
  from: string,
  to: string
): GanttBarPosition | null => {
  if (span.end < from || span.start > to) {
    return null;
  }
  const start = span.start < from ? from : span.start;
  const end = span.end > to ? to : span.end;
  return {
    offset: backlogDaysBetween(from, start),
    length: backlogDaysBetween(start, end) + 1,
    clippedStart: span.start < from,
    clippedEnd: span.end > to,
  };
};

export type GanttPerson = { id: number; name: string };

export type GanttGroup = {
  person: GanttPerson;
  issues: BacklogGanttIssue[];
};

/**
 * The issues per person, in the order the people were added (everyone is
 * listed, even without issues). The issues keep their order.
 */
export const groupByAssignee = (
  issues: BacklogGanttIssue[],
  people: GanttPerson[]
): GanttGroup[] => {
  const groups = people.map((person) => ({
    person,
    issues: [] as BacklogGanttIssue[],
  }));
  const byId = new Map(groups.map((group) => [group.person.id, group]));
  for (const issue of issues) {
    const group = issue.assigneeId ? byId.get(issue.assigneeId) : undefined;
    if (group) {
      group.issues.push(issue);
    } else {
      // Not one of the people (the query asks only for theirs): a group of
      // its own rather than lost
      const person = {
        id: issue.assigneeId ?? 0,
        name: issue.assigneeName,
      };
      const added = { person, issues: [issue] };
      groups.push(added);
      byId.set(person.id, added);
    }
  }
  return groups;
};

// Full-width to half-width, lower case, no spaces, katakana to hiragana
const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Whether the person matches the search: name, login ID or email. */
export const memberMatches = (
  member: BacklogMember,
  keyword: string
): boolean => {
  const k = normalize(keyword);
  if (!k) {
    return true;
  }
  return [member.name, member.userId, member.mailAddress].some(
    (value) => !!value && normalize(value).includes(k)
  );
};

/** The saved people, dropping anything that is not { id, name }. */
export const parseSavedPeople = (saved: string): GanttPerson[] => {
  try {
    const value: unknown = JSON.parse(saved);
    if (!Array.isArray(value)) {
      return [];
    }
    const people = value.filter(
      (item): item is GanttPerson =>
        typeof item === 'object' &&
        item !== null &&
        Number.isInteger(item.id) &&
        item.id > 0 &&
        typeof item.name === 'string'
    );
    const seen = new Set<number>();
    return people
      .filter((person) => !seen.has(person.id) && !!seen.add(person.id))
      .slice(0, MAX_GANTT_PEOPLE)
      .map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
};
