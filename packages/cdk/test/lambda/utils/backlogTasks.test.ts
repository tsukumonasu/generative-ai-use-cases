import { BacklogApiError } from '../../../lambda/utils/backlogApi';
import {
  MAX_TASKS,
  isValidActivitySince,
  listMyActivities,
  listOpenTasks,
  listWeeklyTasks,
  workWeek,
} from '../../../lambda/utils/backlogTasks';

// Sunday 2026-11-08, 10:00 in Japan
const SUNDAY = new Date('2026-11-08T01:00:00Z');

type Handler = (url: URL) => unknown;

// A fake Backlog API: path (without /api/v2) -> JSON body, or a status code
const mockBacklog = (routes: Record<string, unknown | Handler | number>) => {
  const fetchMock = jest.fn<
    Promise<Response>,
    [input: string | URL | Request, init?: RequestInit]
  >(async (input) => {
    const url = new URL(String(input));
    const route = routes[url.pathname.replace(/^\/api\/v2/, '')];
    if (route === undefined) {
      return new Response('{}', { status: 404 });
    }
    if (typeof route === 'number') {
      return new Response('{}', { status: route });
    }
    const body = typeof route === 'function' ? (route as Handler)(url) : route;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const issue = (
  issueKey: string,
  projectId: number,
  dueDate: string | null,
  statusId = 1,
  // Last updated: 2026-11-05 10:00 in Japan by default
  updated = '2026-11-05T01:00:00Z'
) => ({
  id: Number(issueKey.split('-')[1]) + projectId * 1000,
  issueKey,
  summary: `Summary of ${issueKey}`,
  projectId,
  issueType: { name: 'Task' },
  status: { id: statusId, name: statusId === 2 ? 'In Progress' : 'Open' },
  priority: { name: 'Normal' },
  startDate: '2026-11-02T00:00:00Z',
  dueDate,
  updated,
});

const issuesUrls = (fetchMock: ReturnType<typeof mockBacklog>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/api/v2/issues');

describe('workWeek', () => {
  test('runs Monday to Sunday in Japan', () => {
    expect(workWeek(SUNDAY)).toEqual({
      today: '2026-11-08',
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
    });
    // Still Sunday in UTC, already Monday in Japan
    expect(workWeek(new Date('2026-11-08T15:30:00Z'))).toEqual({
      today: '2026-11-09',
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
    });
  });

  test('crosses months and years', () => {
    expect(workWeek(new Date('2026-12-30T03:00:00Z'))).toEqual({
      today: '2026-12-30',
      weekStart: '2026-12-28',
      weekEnd: '2027-01-03',
    });
  });
});

describe('listWeeklyTasks', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  const projects = [
    { id: 1, projectKey: 'PROJ', name: 'Sample Project' },
    { id: 2, projectKey: 'OPS', name: 'OPS' },
  ];
  const statuses = (ids: number[]) => ids.map((id) => ({ id }));

  test("asks for the user's unfinished issues due by the end of the week", async () => {
    const fetchMock = mockBacklog({
      '/users/myself': { id: 77, name: 'Taro Yamada' },
      '/projects': projects,
      '/projects/1/statuses': statuses([1, 2, 3, 4]),
      // A status of the project's own
      '/projects/2/statuses': statuses([1, 2, 3, 4, 20001]),
      '/issues': [],
    });

    await listWeeklyTasks('backlog-token', SUNDAY);

    for (const [input, init] of fetchMock.mock.calls) {
      expect(new URL(String(input)).host).toBe('example.backlog.jp');
      expect(init?.headers).toEqual({ Authorization: 'Bearer backlog-token' });
    }
    const [url] = issuesUrls(fetchMock);
    expect(url.searchParams.getAll('assigneeId[]')).toEqual(['77']);
    // Every status except Closed (4), including the project's own one
    expect(url.searchParams.getAll('statusId[]')).toEqual([
      '1',
      '2',
      '3',
      '20001',
    ]);
    expect(url.searchParams.get('dueDateUntil')).toBe('2026-11-08');
    expect(url.searchParams.get('sort')).toBe('dueDate');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('count')).toBe('100');
  });

  test('splits the issues into overdue and due this week', async () => {
    mockBacklog({
      '/users/myself': { id: 77 },
      '/projects': projects,
      '/projects/1/statuses': statuses([1, 2, 3, 4]),
      '/projects/2/statuses': statuses([1, 2, 3, 4]),
      '/issues': [
        issue('PROJ-201', 1, '2026-11-06T00:00:00Z', 2),
        issue('OPS-88', 2, '2026-11-08T00:00:00Z'),
        issue('PROJ-9', 1, '2026-11-06T00:00:00Z'),
        // No due date, or already done: not on the list
        issue('PROJ-10', 1, null),
        issue('PROJ-11', 1, '2026-11-07T00:00:00Z', 4),
      ],
    });

    const result = await listWeeklyTasks('backlog-token', SUNDAY);

    expect(result.today).toBe('2026-11-08');
    expect(result.weekStart).toBe('2026-11-02');
    expect(result.weekEnd).toBe('2026-11-08');
    expect(result.truncated).toBe(false);
    expect(result.overdue.map((t) => t.issueKey)).toEqual([
      'PROJ-9',
      'PROJ-201',
    ]);
    expect(result.overdue[1]).toEqual({
      issueKey: 'PROJ-201',
      summary: 'Summary of PROJ-201',
      url: 'https://example.backlog.jp/view/PROJ-201',
      projectKey: 'PROJ',
      projectName: 'Sample Project',
      issueType: 'Task',
      status: 'In Progress',
      priority: 'Normal',
      startDate: '2026-11-02',
      dueDate: '2026-11-06',
      updated: '2026-11-05',
      stalled: false,
    });
    expect(result.thisWeek.map((t) => t.issueKey)).toEqual(['OPS-88']);
  });

  test('reads every page up to the limit', async () => {
    const page = (offset: number, size: number) =>
      Array.from({ length: size }, (_, i) =>
        issue(`PROJ-${offset + i + 1}`, 1, '2026-11-08T00:00:00Z')
      );
    const routes = {
      '/users/myself': { id: 77 },
      '/projects': projects.slice(0, 1),
      '/projects/1/statuses': statuses([1, 4]),
    };

    // 100 + 20: everything fits
    let fetchMock = mockBacklog({
      ...routes,
      '/issues': (url: URL) => {
        const offset = Number(url.searchParams.get('offset'));
        return page(offset, offset === 0 ? 100 : 20);
      },
    });
    let result = await listWeeklyTasks('backlog-token', SUNDAY);
    expect(
      issuesUrls(fetchMock).map((u) => u.searchParams.get('offset'))
    ).toEqual(['0', '100']);
    expect(result.thisWeek).toHaveLength(120);
    expect(result.truncated).toBe(false);

    // Always full pages: stops at the limit and says so
    fetchMock = mockBacklog({
      ...routes,
      '/issues': (url: URL) =>
        page(Number(url.searchParams.get('offset')), 100),
    });
    result = await listWeeklyTasks('backlog-token', SUNDAY);
    expect(issuesUrls(fetchMock)).toHaveLength(MAX_TASKS / 100);
    expect(result.thisWeek).toHaveLength(MAX_TASKS);
    expect(result.truncated).toBe(true);
  });

  test('does not search issues for a user with no projects', async () => {
    const fetchMock = mockBacklog({
      '/users/myself': { id: 77 },
      '/projects': [],
    });
    expect(await listWeeklyTasks('backlog-token', SUNDAY)).toEqual({
      today: '2026-11-08',
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      overdue: [],
      thisWeek: [],
      truncated: false,
    });
    expect(issuesUrls(fetchMock)).toHaveLength(0);
  });

  test('throws BacklogApiError with the status Backlog returned', async () => {
    mockBacklog({ '/users/myself': 401, '/projects': 401 });
    await expect(listWeeklyTasks('backlog-token', SUNDAY)).rejects.toEqual(
      expect.objectContaining({ name: 'BacklogApiError', status: 401 })
    );
    await expect(
      listWeeklyTasks('backlog-token', SUNDAY)
    ).rejects.toBeInstanceOf(BacklogApiError);
  });
});

describe('listOpenTasks', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  test('lists every unfinished issue and marks the stalled ones', async () => {
    const fetchMock = mockBacklog({
      '/users/myself': { id: 77 },
      '/projects': [{ id: 1, projectKey: 'PROJ', name: 'Sample Project' }],
      '/projects/1/statuses': [{ id: 1 }, { id: 2 }, { id: 4 }],
      '/issues': [
        issue('PROJ-3', 1, null),
        // Last updated 2026-10-25 in Japan: 14 days before Sunday
        issue('PROJ-2', 1, '2026-12-01T00:00:00Z', 1, '2026-10-24T16:00:00Z'),
        // 13 days before
        issue('PROJ-1', 1, '2026-12-01T00:00:00Z', 1, '2026-10-26T01:00:00Z'),
      ],
    });

    const result = await listOpenTasks('backlog-token', SUNDAY);

    expect(result.today).toBe('2026-11-08');
    expect(result.stalledDays).toBe(14);
    // Soonest due first, no due date last
    expect(result.tasks.map((t) => [t.issueKey, t.updated, t.stalled])).toEqual(
      [
        ['PROJ-1', '2026-10-26', false],
        ['PROJ-2', '2026-10-25', true],
        ['PROJ-3', '2026-11-05', false],
      ]
    );
    const [url] = issuesUrls(fetchMock);
    expect(url.searchParams.get('dueDateUntil')).toBeNull();
    expect(url.searchParams.getAll('statusId[]')).toEqual(['1', '2']);
  });
});

describe('isValidActivitySince', () => {
  test('takes a day within the last 90 days', () => {
    expect(isValidActivitySince('2026-11-01', SUNDAY)).toBe(true);
    expect(isValidActivitySince('2026-11-08', SUNDAY)).toBe(true);
    expect(isValidActivitySince('2026-08-10', SUNDAY)).toBe(true);
    expect(isValidActivitySince('2026-08-09', SUNDAY)).toBe(false);
    expect(isValidActivitySince('2026-11-09', SUNDAY)).toBe(false);
    for (const value of [undefined, '', '2026-11-1', '2026-13-01', 20261101]) {
      expect(isValidActivitySince(value, SUNDAY)).toBe(false);
    }
  });
});

describe('listMyActivities', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  const project = { projectKey: 'PROJ', name: 'Sample Project' };
  const activity = (
    id: number,
    type: number,
    created: string,
    content: Record<string, unknown>
  ) => ({ id, type, project, content, created });

  test('groups what the user did since the day by issue', async () => {
    const fetchMock = mockBacklog({
      '/users/myself': { id: 77 },
      '/users/77/activities': [
        // Newest first
        activity(10, 2, '2026-11-07T03:00:00Z', {
          id: 501,
          key_id: 5,
          summary: 'Old summary',
          changes: [{ field: 'status' }, { field: 'limitDate' }],
          comment: { id: 900, content: 'Done.' },
        }),
        activity(9, 3, '2026-11-06T03:00:00Z', {
          id: 502,
          key_id: 6,
          summary: 'Write the guide',
          comment: { id: 899, content: 'Progress so far.' },
        }),
        activity(8, 1, '2026-11-02T00:30:00Z', {
          id: 501,
          key_id: 5,
          summary: 'Old summary',
        }),
        // Sunday 2026-11-01 in Japan: before the period
        activity(7, 3, '2026-11-01T14:00:00Z', {
          id: 503,
          key_id: 7,
          comment: { id: 800, content: 'Earlier.' },
        }),
      ],
      '/issues': [
        { ...issue('PROJ-5', 0, null, 4), id: 501, summary: 'Ship the page' },
        { ...issue('PROJ-6', 0, null, 2), id: 502 },
      ],
    });

    const result = await listMyActivities(
      'backlog-token',
      '2026-11-02',
      SUNDAY
    );

    expect(result.since).toBe('2026-11-02');
    expect(result.today).toBe('2026-11-08');
    expect(result.truncated).toBe(false);
    expect(result.issues).toEqual([
      {
        issueKey: 'PROJ-5',
        summary: 'Ship the page',
        url: 'https://example.backlog.jp/view/PROJ-5',
        projectKey: 'PROJ',
        projectName: 'Sample Project',
        created: true,
        completed: true,
        comments: [
          {
            id: 900,
            url: 'https://example.backlog.jp/view/PROJ-5#comment-900',
          },
        ],
        updatedFields: ['status', 'limitDate'],
        status: 'Open',
        lastActivity: '2026-11-07T03:00:00Z',
      },
      expect.objectContaining({
        issueKey: 'PROJ-6',
        created: false,
        completed: false,
        comments: [
          {
            id: 899,
            url: 'https://example.backlog.jp/view/PROJ-6#comment-899',
          },
        ],
        status: 'In Progress',
      }),
    ]);

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    const activitiesUrl = urls.find((u) => u.pathname.endsWith('/activities'));
    expect(activitiesUrl?.searchParams.getAll('activityTypeId[]')).toEqual([
      '1',
      '2',
      '3',
    ]);
    // Only one page: the last activity on it is older than the period
    expect(urls.filter((u) => u.pathname.endsWith('/activities'))).toHaveLength(
      1
    );
    expect(issuesUrls(fetchMock)[0].searchParams.getAll('id[]')).toEqual([
      '501',
      '502',
    ]);
  });

  test('reads older pages while the activities are in the period', async () => {
    const fetchMock = mockBacklog({
      '/users/myself': { id: 77 },
      '/users/77/activities': (url: URL) => {
        const maxId = Number(url.searchParams.get('maxId') ?? 1000);
        // 100 activities per page, all on Saturday
        return Array.from({ length: 100 }, (_, i) =>
          activity(maxId - i, 3, '2026-11-07T03:00:00Z', {
            id: 600 + ((maxId - i) % 3),
            key_id: (maxId - i) % 3,
            comment: { id: maxId - i, content: 'Comment.' },
          })
        );
      },
      '/issues': [],
    });

    const result = await listMyActivities(
      'backlog-token',
      '2026-11-02',
      SUNDAY
    );

    const pages = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((u) => u.pathname.endsWith('/activities'));
    expect(pages.map((u) => u.searchParams.get('maxId'))).toEqual([
      null,
      '900',
      '800',
      '700',
      '600',
    ]);
    expect(result.truncated).toBe(true);
    expect(result.issues).toHaveLength(3);
  });
});
