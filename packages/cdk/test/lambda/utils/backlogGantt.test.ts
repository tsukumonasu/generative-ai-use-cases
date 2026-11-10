import { BacklogApiError } from '../../../lambda/utils/backlogApi';
import {
  MAX_GANTT_DAYS,
  MAX_GANTT_PEOPLE,
  ganttSpan,
  listGanttIssues,
  listMembers,
  parseGanttQuery,
} from '../../../lambda/utils/backlogGantt';

// Monday 2026-11-09, 10:00 in Japan
const MONDAY = new Date('2026-11-09T01:00:00Z');

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

const issuesUrls = (fetchMock: ReturnType<typeof mockBacklog>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === '/api/v2/issues');

const isClosedQuery = (url: URL) =>
  url.searchParams.getAll('statusId[]').includes('4');

const issue = (
  issueKey: string,
  startDate: string | null,
  dueDate: string | null,
  {
    statusId = 1,
    color = '#ed8077',
    assignee = { id: 77, name: 'Taro Yamada' },
  }: {
    statusId?: number;
    color?: string;
    assignee?: { id: number; name: string } | null;
  } = {}
) => ({
  id: Number(issueKey.split('-')[1]),
  issueKey,
  summary: `Summary of ${issueKey}`,
  projectId: issueKey.startsWith('QA') ? 2 : 1,
  issueType: { name: 'Task' },
  status: { id: statusId, name: statusId === 4 ? 'Closed' : 'Open', color },
  priority: { name: 'Normal' },
  assignee,
  startDate: startDate && `${startDate}T00:00:00Z`,
  dueDate: dueDate && `${dueDate}T00:00:00Z`,
  updated: '2026-11-05T01:00:00Z',
});

const projects = [
  { id: 1, projectKey: 'PROJ', name: 'Sample Project' },
  { id: 2, projectKey: 'QA', name: 'QA' },
];
const statuses = (ids: number[]) => ids.map((id) => ({ id }));

describe('parseGanttQuery', () => {
  const valid = {
    assigneeIds: '77, 88,77',
    from: '2026-11-02',
    to: '2026-12-27',
  };

  test('reads the people, the period and the options', () => {
    expect(parseGanttQuery(valid)).toEqual({
      value: {
        assigneeIds: [77, 88],
        from: '2026-11-02',
        to: '2026-12-27',
        projectKey: undefined,
        includeClosed: false,
      },
    });
    expect(
      parseGanttQuery({ ...valid, projectKey: 'PROJ', includeClosed: 'true' })
    ).toMatchObject({ value: { projectKey: 'PROJ', includeClosed: true } });
    // An empty project means every project
    expect(parseGanttQuery({ ...valid, projectKey: '' })).toMatchObject({
      value: { projectKey: undefined },
    });
  });

  test('needs Backlog user IDs, not too many', () => {
    for (const assigneeIds of [undefined, '', ',', '77,abc', '0', '-1']) {
      expect(parseGanttQuery({ ...valid, assigneeIds })).toHaveProperty(
        'error'
      );
    }
    // Repeated query parameters arrive as an array
    expect(parseGanttQuery({ ...valid, assigneeIds: ['77'] })).toHaveProperty(
      'error'
    );
    const many = Array.from({ length: MAX_GANTT_PEOPLE + 1 }, (_, i) => i + 1);
    expect(
      parseGanttQuery({ ...valid, assigneeIds: many.join(',') })
    ).toHaveProperty('error');
    expect(
      parseGanttQuery({ ...valid, assigneeIds: many.slice(1).join(',') })
    ).toHaveProperty('value');
  });

  test('needs real days, in order, within the longest period', () => {
    for (const period of [
      { from: '2026-11-2', to: '2026-12-27' },
      { from: '2026-02-30', to: '2026-03-27' },
      { from: '2026-12-27', to: '2026-11-02' },
      { from: '2026-11-02', to: undefined },
    ]) {
      expect(parseGanttQuery({ ...valid, ...period })).toHaveProperty('error');
    }
    // One day is a period
    expect(
      parseGanttQuery({ ...valid, from: '2026-11-09', to: '2026-11-09' })
    ).toHaveProperty('value');
    const last = new Date(Date.parse('2026-11-01T00:00:00Z'));
    last.setUTCDate(last.getUTCDate() + MAX_GANTT_DAYS - 1);
    const to = last.toISOString().slice(0, 10);
    expect(
      parseGanttQuery({ ...valid, from: '2026-11-01', to })
    ).toHaveProperty('value');
    last.setUTCDate(last.getUTCDate() + 1);
    expect(
      parseGanttQuery({
        ...valid,
        from: '2026-11-01',
        to: last.toISOString().slice(0, 10),
      })
    ).toHaveProperty('error');
  });

  test('rejects a project key that is not one', () => {
    expect(
      parseGanttQuery({ ...valid, projectKey: '../users' })
    ).toHaveProperty('error');
  });
});

describe('ganttSpan', () => {
  const today = '2026-11-09';
  const span = (
    startDate: string | undefined,
    dueDate: string | undefined,
    closed = false
  ) => ganttSpan({ startDate, dueDate, closed }, today);

  test('runs from the start date to the due date', () => {
    expect(span('2026-11-02', '2026-11-20')).toEqual({
      start: '2026-11-02',
      end: '2026-11-20',
      hasStart: true,
      hasEnd: true,
    });
    // Dates entered the wrong way round
    expect(span('2026-11-20', '2026-11-02')).toMatchObject({
      start: '2026-11-02',
      end: '2026-11-20',
    });
  });

  test('is the due date alone without a start date', () => {
    expect(span(undefined, '2026-11-20')).toEqual({
      start: '2026-11-20',
      end: '2026-11-20',
      hasStart: false,
      hasEnd: true,
    });
  });

  test('runs to today while an issue without a due date is unfinished', () => {
    expect(span('2026-11-02', undefined)).toEqual({
      start: '2026-11-02',
      end: today,
      hasStart: true,
      hasEnd: false,
    });
    expect(span('2026-11-02', undefined, true)).toMatchObject({
      end: '2026-11-02',
    });
    // Starts later than today
    expect(span('2026-11-30', undefined)).toMatchObject({
      start: '2026-11-30',
      end: '2026-11-30',
    });
  });

  test('has nothing to draw without dates', () => {
    expect(span(undefined, undefined)).toBeUndefined();
  });
});

describe('listMembers', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  test("lists the members of the user's projects once each, in name order", async () => {
    mockBacklog({
      '/users/myself': { id: 77, userId: 'taro', name: 'Yamada Taro' },
      '/projects': [projects[1], projects[0]],
      '/projects/1/users': [
        { id: 77, userId: 'taro', name: 'Yamada Taro', mailAddress: null },
        {
          id: 88,
          userId: 'hanako',
          name: 'Suzuki Hanako',
          mailAddress: 'hanako@example.co.jp',
        },
      ],
      '/projects/2/users': [
        { id: 88, userId: 'hanako', name: 'Suzuki Hanako' },
      ],
    });

    const result = await listMembers('backlog-token');

    expect(result.myself).toEqual({
      id: 77,
      name: 'Yamada Taro',
      userId: 'taro',
      mailAddress: undefined,
      projectKeys: ['PROJ'],
    });
    expect(result.members).toEqual([
      {
        id: 88,
        name: 'Suzuki Hanako',
        userId: 'hanako',
        mailAddress: 'hanako@example.co.jp',
        projectKeys: ['PROJ', 'QA'],
      },
      result.myself,
    ]);
  });

  test('includes the user even without projects', async () => {
    mockBacklog({
      '/users/myself': { id: 77, name: 'Yamada Taro' },
      '/projects': [],
    });
    const result = await listMembers('backlog-token');
    expect(result.members).toEqual([result.myself]);
    expect(result.myself.projectKeys).toEqual([]);
  });
});

describe('listGanttIssues', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  const base = {
    '/projects': projects,
    '/projects/1/statuses': statuses([1, 2, 3, 4]),
    '/projects/2/statuses': statuses([1, 2, 3, 4, 20001]),
  };
  const query = {
    assigneeIds: [77, 88],
    from: '2026-11-02',
    to: '2026-11-29',
    includeClosed: false,
  };

  test("asks for the people's unfinished issues in every project", async () => {
    const fetchMock = mockBacklog({ ...base, '/issues': [] });

    await listGanttIssues('backlog-token', query, MONDAY);

    const urls = issuesUrls(fetchMock);
    expect(urls).toHaveLength(1);
    const [url] = urls;
    expect(url.searchParams.getAll('assigneeId[]')).toEqual(['77', '88']);
    expect(url.searchParams.getAll('statusId[]')).toEqual([
      '1',
      '2',
      '3',
      '20001',
    ]);
    expect(url.searchParams.getAll('projectId[]')).toEqual([]);
    expect(url.searchParams.get('dueDateSince')).toBeNull();
  });

  test('narrows to one project, with only its statuses', async () => {
    const fetchMock = mockBacklog({ ...base, '/issues': [] });

    await listGanttIssues(
      'backlog-token',
      { ...query, projectKey: 'PROJ' },
      MONDAY
    );

    const [url] = issuesUrls(fetchMock);
    expect(url.searchParams.getAll('projectId[]')).toEqual(['1']);
    expect(url.searchParams.getAll('statusId[]')).toEqual(['1', '2', '3']);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/projects/2/statuses')
      )
    ).toBe(false);
  });

  test('refuses a project the user is not in', async () => {
    mockBacklog({ ...base, '/issues': [] });
    await expect(
      listGanttIssues('backlog-token', { ...query, projectKey: 'HR' }, MONDAY)
    ).rejects.toBeInstanceOf(BacklogApiError);
  });

  test('asks for Closed issues due from the start of the period only when asked', async () => {
    const fetchMock = mockBacklog({ ...base, '/issues': [] });

    await listGanttIssues(
      'backlog-token',
      { ...query, includeClosed: true },
      MONDAY
    );

    const closed = issuesUrls(fetchMock).filter(isClosedQuery);
    expect(closed).toHaveLength(1);
    expect(closed[0].searchParams.getAll('statusId[]')).toEqual(['4']);
    expect(closed[0].searchParams.get('dueDateSince')).toBe('2026-11-02');
    expect(closed[0].searchParams.getAll('assigneeId[]')).toEqual(['77', '88']);
  });

  test('splits the issues into the chart and the rest', async () => {
    mockBacklog({
      ...base,
      '/issues': (url: URL) =>
        isClosedQuery(url)
          ? [
              issue('PROJ-50', '2026-11-03', '2026-11-05', {
                statusId: 4,
                color: '#b0be3c',
              }),
              // Closed after the period: not counted anywhere
              issue('PROJ-51', '2026-12-01', '2026-12-03', { statusId: 4 }),
            ]
          : [
              issue('PROJ-10', '2026-11-10', '2026-11-20'),
              issue('QA-3', '2026-10-20', '2026-11-04', {
                statusId: 2,
                color: 'red; background: url(x)',
                assignee: { id: 88, name: 'Suzuki Hanako' },
              }),
              // Due only, started only (runs to today), no dates
              issue('PROJ-11', null, '2026-11-12'),
              issue('PROJ-12', '2026-10-01', null),
              issue('PROJ-13', null, null),
              // Due before the period, starts after it
              issue('PROJ-14', '2026-10-01', '2026-10-31'),
              issue('PROJ-15', '2026-12-01', '2026-12-10'),
              issue('PROJ-16', null, '2026-12-05'),
            ],
    });

    const result = await listGanttIssues(
      'backlog-token',
      { ...query, includeClosed: true },
      MONDAY
    );

    expect(result).toMatchObject({
      today: '2026-11-09',
      from: '2026-11-02',
      to: '2026-11-29',
      later: 2,
      truncated: false,
    });
    expect(result.issues.map((i) => i.issueKey)).toEqual([
      'PROJ-12',
      'QA-3',
      'PROJ-50',
      'PROJ-10',
      'PROJ-11',
    ]);
    const byKey = Object.fromEntries(result.issues.map((i) => [i.issueKey, i]));
    expect(byKey['PROJ-12'].span).toEqual({
      start: '2026-10-01',
      end: '2026-11-09',
      hasStart: true,
      hasEnd: false,
    });
    expect(byKey['QA-3']).toMatchObject({
      assigneeId: 88,
      assigneeName: 'Suzuki Hanako',
      projectKey: 'QA',
      closed: false,
      // Only a color code reaches the page
      statusColor: undefined,
    });
    expect(byKey['PROJ-50']).toMatchObject({
      closed: true,
      statusColor: '#b0be3c',
    });
    expect(result.undated.map((i) => i.issueKey)).toEqual(['PROJ-13']);
    expect(result.undated[0].span).toBeUndefined();
    expect(result.earlier.map((i) => i.issueKey)).toEqual(['PROJ-14']);
  });

  test('tells when there were more issues than it reads', async () => {
    const page = Array.from({ length: 100 }, (_, i) =>
      issue(`PROJ-${i + 1}`, '2026-11-10', '2026-11-20')
    );
    const fetchMock = mockBacklog({ ...base, '/issues': page });

    const result = await listGanttIssues('backlog-token', query, MONDAY);

    expect(result.truncated).toBe(true);
    expect(issuesUrls(fetchMock)).toHaveLength(5);
  });
});
