import {
  BacklogGanttIssue,
  BacklogGanttResponse,
  BacklogMember,
  BacklogMembersResponse,
} from 'generative-ai-use-cases';
import { BacklogApiError, backlogGet } from './backlogApi';
import { PROJECT_KEY_PATTERN } from './backlogIssues';
import {
  BacklogIssue,
  BacklogProject,
  CLOSED_STATUS_ID,
  MAX_PARALLEL_REQUESTS,
  japanDate,
  listIssuePages,
  listMyProjects,
  listOpenStatusIds,
  mapLimited,
  toTask,
} from './backlogTasks';

// The gantt chart of the Backlog page (GET /backlog/members and
// /backlog/gantt). Read with the user's own token over the projects the user
// belongs to, so the chart shows exactly what the user can see in Backlog.

// People on one chart at most
export const MAX_GANTT_PEOPLE = 20;
// The longest period, about six months
export const MAX_GANTT_DAYS = 186;
// Issues read at most, unfinished and Closed each
export const MAX_GANTT_ISSUES = 500;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const USER_ID_PATTERN = /^[1-9]\d{0,9}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type RawUser = {
  id: number;
  userId?: string | null;
  name: string;
  mailAddress?: string | null;
};

export type GanttQuery = {
  // Backlog user IDs (assigneeId)
  assigneeIds: number[];
  // YYYY-MM-DD, both included
  from: string;
  to: string;
  projectKey?: string;
  includeClosed: boolean;
};

const isDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  DAY_PATTERN.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  // Rejects days that roll over, e.g. 2026-02-30
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** Days from `from` to `to` (YYYY-MM-DD); 0 for the same day. */
export const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );

/**
 * The query of GET /backlog/gantt: assigneeIds (comma-separated), from, to
 * (YYYY-MM-DD), and optionally projectKey and includeClosed=true.
 */
export const parseGanttQuery = (
  query: Record<string, unknown>
): { value: GanttQuery } | { error: string } => {
  const ids =
    typeof query.assigneeIds === 'string'
      ? query.assigneeIds
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];
  if (ids.length === 0) {
    return { error: 'assigneeIds is required' };
  }
  if (!ids.every((id) => USER_ID_PATTERN.test(id))) {
    return { error: 'assigneeIds must be Backlog user IDs' };
  }
  const assigneeIds = [...new Set(ids.map(Number))];
  if (assigneeIds.length > MAX_GANTT_PEOPLE) {
    return { error: `Up to ${MAX_GANTT_PEOPLE} people at a time` };
  }

  const { from, to } = query;
  if (!isDay(from) || !isDay(to)) {
    return { error: 'from and to must be days (YYYY-MM-DD)' };
  }
  const days = daysBetween(from, to) + 1;
  if (days < 1 || days > MAX_GANTT_DAYS) {
    return {
      error: `The period must be 1 to ${MAX_GANTT_DAYS} days, from before to`,
    };
  }

  const projectKey = query.projectKey;
  if (
    projectKey !== undefined &&
    projectKey !== '' &&
    (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey))
  ) {
    return { error: 'projectKey is invalid' };
  }

  return {
    value: {
      assigneeIds,
      from,
      to,
      projectKey: projectKey ? (projectKey as string) : undefined,
      includeClosed: query.includeClosed === 'true',
    },
  };
};

const toMember = (user: RawUser): BacklogMember => ({
  id: user.id,
  name: user.name,
  userId: user.userId ?? undefined,
  mailAddress: user.mailAddress ?? undefined,
  projectKeys: [],
});

/**
 * The people whose issues the user can put on the chart: the members of the
 * projects the user belongs to, each with those projects, in name order.
 */
export const listMembers = async (
  accessToken: string
): Promise<BacklogMembersResponse> => {
  const [me, projects] = await Promise.all([
    backlogGet<RawUser>(accessToken, '/users/myself'),
    listMyProjects(accessToken),
  ]);
  const sorted = [...projects].sort((a, b) =>
    a.projectKey.localeCompare(b.projectKey)
  );
  const userLists = await mapLimited(sorted, MAX_PARALLEL_REQUESTS, (project) =>
    backlogGet<RawUser[]>(accessToken, `/projects/${project.id}/users`)
  );

  const members = new Map<number, BacklogMember>();
  sorted.forEach((project, index) => {
    for (const user of userLists[index]) {
      const member = members.get(user.id) ?? toMember(user);
      member.projectKeys.push(project.projectKey);
      members.set(user.id, member);
    }
  });
  const myself = members.get(me.id) ?? toMember(me);
  members.set(me.id, myself);
  return {
    myself,
    members: [...members.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'ja')
    ),
  };
};

/**
 * What the chart draws for an issue: start date to due date. Without a
 * start date the bar is the due date alone; an unfinished issue without a
 * due date runs from its start to today (it is still going on).
 */
export const ganttSpan = (
  issue: Pick<BacklogGanttIssue, 'startDate' | 'dueDate' | 'closed'>,
  today: string
): BacklogGanttIssue['span'] => {
  const { startDate, dueDate } = issue;
  if (startDate && dueDate) {
    const [start, end] =
      startDate <= dueDate ? [startDate, dueDate] : [dueDate, startDate];
    return { start, end, hasStart: true, hasEnd: true };
  }
  if (dueDate) {
    return { start: dueDate, end: dueDate, hasStart: false, hasEnd: true };
  }
  if (startDate) {
    const end = !issue.closed && today > startDate ? today : startDate;
    return { start: startDate, end, hasStart: true, hasEnd: false };
  }
  return undefined;
};

const byIssueKey = (a: BacklogGanttIssue, b: BacklogGanttIssue) =>
  a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true });

/**
 * The people's unfinished issues, and with includeClosed their Closed issues
 * due on or after the start of the period, split into what is on the chart
 * and what is not. Throws BacklogApiError when Backlog refuses a request.
 */
export const listGanttIssues = async (
  accessToken: string,
  query: GanttQuery,
  now: Date = new Date()
): Promise<BacklogGanttResponse> => {
  const today = japanDate(now);
  const projects = await listMyProjects(accessToken);
  const scoped = query.projectKey
    ? projects.filter((project) => project.projectKey === query.projectKey)
    : projects;
  if (query.projectKey && scoped.length === 0) {
    // Not a project of the user (or archived)
    throw new BacklogApiError(404, `/projects/${query.projectKey}`);
  }
  const narrow = {
    assigneeId: query.assigneeIds,
    projectId: query.projectKey
      ? scoped.map((project) => project.id)
      : undefined,
  };

  const openStatusIds = await listOpenStatusIds(accessToken, scoped);
  const none = { issues: [] as BacklogIssue[], truncated: false };
  const [open, closed] = await Promise.all([
    openStatusIds.length > 0
      ? listIssuePages(
          accessToken,
          {
            ...narrow,
            statusId: openStatusIds,
            sort: 'startDate',
            order: 'asc',
          },
          MAX_GANTT_ISSUES
        )
      : none,
    // Closed issues only near the period: the due date is the end of a bar,
    // so one due before the period cannot be on the chart
    query.includeClosed
      ? listIssuePages(
          accessToken,
          {
            ...narrow,
            statusId: [CLOSED_STATUS_ID],
            dueDateSince: query.from,
            sort: 'dueDate',
            order: 'asc',
          },
          MAX_GANTT_ISSUES
        )
      : none,
  ]);

  const projectById = new Map<number, BacklogProject>(
    projects.map((project) => [project.id, project])
  );
  const unique = new Map<string, BacklogIssue>();
  for (const issue of [...open.issues, ...closed.issues]) {
    unique.set(issue.issueKey, issue);
  }

  type Placed = BacklogGanttIssue & {
    span: NonNullable<BacklogGanttIssue['span']>;
  };
  const issues: Placed[] = [];
  const undated: BacklogGanttIssue[] = [];
  const earlier: Placed[] = [];
  let later = 0;
  for (const raw of unique.values()) {
    const color = raw.status?.color;
    const issue: BacklogGanttIssue = {
      ...toTask(raw, projectById, today),
      assigneeId: raw.assignee?.id,
      assigneeName: raw.assignee?.name ?? '',
      statusColor: color && COLOR_PATTERN.test(color) ? color : undefined,
      closed: raw.status?.id === CLOSED_STATUS_ID,
    };
    const span = ganttSpan(issue, today);
    if (span && span.end >= query.from && span.start <= query.to) {
      issues.push({ ...issue, span });
    } else if (issue.closed) {
      // Closed issues are only for the chart
      continue;
    } else if (!span) {
      undated.push(issue);
    } else if (span.end < query.from) {
      earlier.push({ ...issue, span });
    } else {
      later += 1;
    }
  }

  issues.sort(
    (a, b) =>
      a.span.start.localeCompare(b.span.start) ||
      a.span.end.localeCompare(b.span.end) ||
      byIssueKey(a, b)
  );
  earlier.sort(
    (a, b) => a.span.end.localeCompare(b.span.end) || byIssueKey(a, b)
  );
  undated.sort(byIssueKey);

  return {
    today,
    from: query.from,
    to: query.to,
    issues,
    undated,
    earlier,
    later,
    truncated: open.truncated || closed.truncated,
  };
};
