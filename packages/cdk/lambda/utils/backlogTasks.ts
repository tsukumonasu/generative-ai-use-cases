import {
  BacklogActivitiesResponse,
  BacklogIssueActivity,
  BacklogOpenTasksResponse,
  BacklogTask,
  BacklogWeeklyTasksResponse,
} from 'generative-ai-use-cases';
import {
  BacklogQuery,
  backlogCommentUrl,
  backlogGet,
  backlogIssueUrl,
} from './backlogApi';

// The read-only lists of the Backlog page (GET /backlog/tasks,
// /backlog/my-issues and /backlog/activities). Read with the user's own
// token, so they show exactly what the user can see.

// The Closed status exists in every project with this ID. Statuses a project
// adds itself get other IDs, so "unfinished" is every status except this one.
export const CLOSED_STATUS_ID = 4;

// An unfinished issue not updated for this many days counts as stalled
export const STALLED_DAYS = 14;

const TIME_ZONE = 'Asia/Tokyo';
const PAGE_SIZE = 100;
export const MAX_TASKS = 300;
// Activities read at most (pages of 100, newest first)
export const MAX_ACTIVITIES = 500;
// How far back the activity summary may go
export const MAX_ACTIVITY_DAYS = 90;
// Requests to Backlog at the same time (one per project for the statuses)
export const MAX_PARALLEL_REQUESTS = 8;

// Activity types of the user's recent updates
const ACTIVITY_ISSUE_CREATED = 1;
const ACTIVITY_ISSUE_UPDATED = 2;
const ACTIVITY_ISSUE_COMMENTED = 3;

export type BacklogProject = { id: number; projectKey: string; name: string };
type BacklogStatus = { id: number };
export type BacklogIssue = {
  id: number;
  issueKey: string;
  summary: string;
  projectId: number;
  issueType?: { name?: string } | null;
  status?: { id?: number; name?: string; color?: string } | null;
  assignee?: { id?: number; name?: string } | null;
  priority?: { name?: string } | null;
  startDate?: string | null;
  dueDate?: string | null;
  updated?: string | null;
};
type BacklogActivity = {
  id: number;
  type: number;
  project?: { projectKey?: string; name?: string } | null;
  content?: {
    id?: number;
    key_id?: number;
    summary?: string;
    comment?: { id?: number; content?: string | null } | null;
    changes?: { field?: string }[] | null;
  } | null;
  created: string;
};

export type WorkWeek = {
  today: string;
  weekStart: string;
  weekEnd: string;
};

const japanDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The day in Japan, as YYYY-MM-DD. */
export const japanDate = (date: Date): string => japanDateFormat.format(date);

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Today and this week (Monday to Sunday) in Japan, as YYYY-MM-DD. */
export const workWeek = (now: Date): WorkWeek => {
  const today = japanDate(now);
  // 0 = Sunday
  const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekStart = addDays(today, -((dayOfWeek + 6) % 7));
  return { today, weekStart, weekEnd: addDays(weekStart, 6) };
};

export const mapLimited = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};

// Backlog dates look like "2026-11-12T00:00:00Z" and mean that day
const toDate = (value: string | null | undefined): string | undefined =>
  value ? value.slice(0, 10) : undefined;

const byDueDate = (a: BacklogTask, b: BacklogTask): number => {
  if (a.dueDate !== b.dueDate) {
    // Issues without a due date go last
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  return a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true });
};

/** The projects the user belongs to (archived ones left out). */
export const listMyProjects = (accessToken: string) =>
  backlogGet<BacklogProject[]>(accessToken, '/projects', {
    archived: 'false',
  });

/**
 * Every status of the projects except Closed: what "unfinished" means. The
 * projects' own statuses have IDs of their own, so the IDs are collected.
 */
export const listOpenStatusIds = async (
  accessToken: string,
  projects: BacklogProject[]
): Promise<number[]> => {
  const statusLists = await mapLimited(
    projects,
    MAX_PARALLEL_REQUESTS,
    (project) =>
      backlogGet<BacklogStatus[]>(
        accessToken,
        `/projects/${project.id}/statuses`
      )
  );
  return [...new Set(statusLists.flat().map((status) => status.id))]
    .filter((id) => id !== CLOSED_STATUS_ID)
    .sort((a, b) => a - b);
};

/**
 * GET /issues page by page until `max` issues have been read. `truncated`
 * tells that more issues matched.
 */
export const listIssuePages = async (
  accessToken: string,
  query: BacklogQuery,
  max: number
): Promise<{ issues: BacklogIssue[]; truncated: boolean }> => {
  const issues: BacklogIssue[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await backlogGet<BacklogIssue[]>(accessToken, '/issues', {
      ...query,
      count: PAGE_SIZE,
      offset,
    });
    issues.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
    if (issues.length >= max) {
      truncated = true;
      break;
    }
  }
  return { issues, truncated };
};

/** An issue as a row of the Backlog page. */
export const toTask = (
  issue: BacklogIssue,
  projectById: Map<number, BacklogProject>,
  today: string
): BacklogTask => {
  const project = projectById.get(issue.projectId);
  const updated = issue.updated ? japanDate(new Date(issue.updated)) : today;
  return {
    issueKey: issue.issueKey,
    summary: issue.summary,
    url: backlogIssueUrl(issue.issueKey),
    projectKey: project?.projectKey ?? issue.issueKey.split('-')[0],
    projectName: project?.name ?? '',
    issueType: issue.issueType?.name ?? '',
    status: issue.status?.name ?? '',
    priority: issue.priority?.name ?? '',
    startDate: toDate(issue.startDate),
    dueDate: toDate(issue.dueDate),
    updated,
    stalled: updated <= addDays(today, -STALLED_DAYS),
  };
};

/**
 * Unfinished issues assigned to the user, read page by page up to MAX_TASKS.
 * `query` narrows the search further (e.g. dueDateUntil).
 */
const listMyOpenIssues = async (
  accessToken: string,
  today: string,
  query: BacklogQuery
): Promise<{ tasks: BacklogTask[]; truncated: boolean }> => {
  const [me, projects] = await Promise.all([
    backlogGet<{ id: number }>(accessToken, '/users/myself'),
    listMyProjects(accessToken),
  ]);

  const openStatusIds = await listOpenStatusIds(accessToken, projects);
  if (openStatusIds.length === 0) {
    return { tasks: [], truncated: false };
  }

  const { issues, truncated } = await listIssuePages(
    accessToken,
    {
      assigneeId: [me.id],
      statusId: openStatusIds,
      sort: 'dueDate',
      order: 'asc',
      ...query,
    },
    MAX_TASKS
  );

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const tasks = issues
    .filter((issue) => issue.status?.id !== CLOSED_STATUS_ID)
    .map((issue) => toTask(issue, projectById, today))
    .sort(byDueDate);
  return { tasks, truncated };
};

/**
 * The user's unfinished issues due by the end of this week, split into
 * overdue and due this week, soonest first. Issues without a due date are
 * left out. Throws BacklogApiError when Backlog refuses a request.
 */
export const listWeeklyTasks = async (
  accessToken: string,
  now: Date = new Date()
): Promise<BacklogWeeklyTasksResponse> => {
  const week = workWeek(now);
  const { tasks, truncated } = await listMyOpenIssues(accessToken, week.today, {
    dueDateUntil: week.weekEnd,
  });
  const due = tasks.filter(
    (task): task is BacklogTask & { dueDate: string } => !!task.dueDate
  );
  return {
    ...week,
    overdue: due.filter((task) => task.dueDate < week.today),
    thisWeek: due.filter((task) => task.dueDate >= week.today),
    truncated,
  };
};

/**
 * Every unfinished issue assigned to the user, soonest due first, with the
 * ones not updated for STALLED_DAYS days marked as stalled.
 */
export const listOpenTasks = async (
  accessToken: string,
  now: Date = new Date()
): Promise<BacklogOpenTasksResponse> => {
  const today = japanDate(now);
  const { tasks, truncated } = await listMyOpenIssues(accessToken, today, {});
  return { today, stalledDays: STALLED_DAYS, tasks, truncated };
};

/** Whether `since` is a day the activity summary can start from. */
export const isValidActivitySince = (since: unknown, now: Date): boolean => {
  if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return false;
  }
  if (Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
    return false;
  }
  const today = japanDate(now);
  return since <= today && since >= addDays(today, -MAX_ACTIVITY_DAYS);
};

/**
 * What the user did on issues since the start of `since` (a day in Japan):
 * added, updated, commented and completed issues, most recent first.
 */
export const listMyActivities = async (
  accessToken: string,
  since: string,
  now: Date = new Date()
): Promise<BacklogActivitiesResponse> => {
  const today = japanDate(now);
  const sinceTime = Date.parse(`${since}T00:00:00+09:00`);
  const me = await backlogGet<{ id: number }>(accessToken, '/users/myself');

  const activities: BacklogActivity[] = [];
  let truncated = false;
  let maxId: number | undefined;
  for (;;) {
    const page = await backlogGet<BacklogActivity[]>(
      accessToken,
      `/users/${me.id}/activities`,
      {
        activityTypeId: [
          ACTIVITY_ISSUE_CREATED,
          ACTIVITY_ISSUE_UPDATED,
          ACTIVITY_ISSUE_COMMENTED,
        ],
        count: PAGE_SIZE,
        order: 'desc',
        maxId,
      }
    );
    const recent = page.filter(
      (activity) => Date.parse(activity.created) >= sinceTime
    );
    activities.push(...recent);
    if (page.length < PAGE_SIZE || recent.length < page.length) {
      break;
    }
    if (activities.length >= MAX_ACTIVITIES) {
      truncated = true;
      break;
    }
    maxId = page[page.length - 1].id - 1;
  }

  type Entry = BacklogIssueActivity & {
    issueId: number;
    statusChanged: boolean;
    fields: Set<string>;
  };
  const entries = new Map<number, Entry>();
  // Newest first, so the first activity of an issue is its latest
  for (const activity of activities) {
    const content = activity.content;
    const projectKey = activity.project?.projectKey;
    if (!content?.id || content.key_id === undefined || !projectKey) {
      continue;
    }
    let entry = entries.get(content.id);
    if (!entry) {
      const issueKey = `${projectKey}-${content.key_id}`;
      entry = {
        issueId: content.id,
        issueKey,
        summary: content.summary ?? '',
        url: backlogIssueUrl(issueKey),
        projectKey,
        projectName: activity.project?.name ?? '',
        created: false,
        completed: false,
        comments: [],
        updatedFields: [],
        lastActivity: activity.created,
        statusChanged: false,
        fields: new Set(),
      };
      entries.set(content.id, entry);
    }
    if (activity.type === ACTIVITY_ISSUE_CREATED) {
      entry.created = true;
    }
    for (const change of content.changes ?? []) {
      if (change.field) {
        entry.fields.add(change.field);
        entry.statusChanged ||= change.field === 'status';
      }
    }
    // A comment, or an update that came with a comment
    const comment = content.comment;
    if (comment?.id && comment.content) {
      entry.comments.unshift({
        id: comment.id,
        url: backlogCommentUrl(entry.issueKey, comment.id),
      });
    }
  }

  // The current status tells whether a status change completed the issue
  const issueIds = [...entries.keys()];
  const current = new Map<number, BacklogIssue>();
  for (let i = 0; i < issueIds.length; i += PAGE_SIZE) {
    const page = await backlogGet<BacklogIssue[]>(accessToken, '/issues', {
      id: issueIds.slice(i, i + PAGE_SIZE),
      count: PAGE_SIZE,
    });
    page.forEach((issue) => current.set(issue.id, issue));
  }

  const issues = [...entries.values()].map(
    ({ issueId, statusChanged, fields, ...entry }): BacklogIssueActivity => {
      const issue = current.get(issueId);
      return {
        ...entry,
        summary: issue?.summary ?? entry.summary,
        status: issue?.status?.name ?? undefined,
        completed: statusChanged && issue?.status?.id === CLOSED_STATUS_ID,
        updatedFields: [...fields],
      };
    }
  );
  return { since, today, issues, truncated };
};
