import {
  DUPLICATE_WINDOW_MS,
  addComment,
  createDocument,
  createIssue,
  listDocumentFolders,
  parseCreateDocumentRequest,
  getIssueDetail,
  getProjectMeta,
  parseCommentContent,
  parseCreateIssueRequest,
} from '../../../lambda/utils/backlogIssues';

const NOW = new Date('2026-11-08T01:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();

type Call = { method: string; path: string; url: URL; form: URLSearchParams };
type Handler = (call: Call) => unknown;

// A fake Backlog API: "METHOD /path" (without /api/v2) -> JSON body, a
// handler, or a status code
const mockBacklog = (routes: Record<string, unknown | Handler | number>) => {
  const calls: Call[] = [];
  global.fetch = jest.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v2/, '');
      const call = {
        method,
        path,
        url,
        form: new URLSearchParams(String(init?.body ?? '')),
      };
      calls.push(call);
      const route = routes[`${method} ${path}`];
      if (route === undefined) {
        return new Response('{}', { status: 404 });
      }
      if (typeof route === 'number') {
        return new Response('{}', { status: route });
      }
      const body =
        typeof route === 'function' ? (route as Handler)(call) : route;
      return new Response(JSON.stringify(body), { status: 200 });
    }
  ) as unknown as typeof fetch;
  return calls;
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

const request = {
  projectKey: 'OPS',
  summary: 'Renew the bot model',
  description: '## Overview\n- Update the model ID',
  issueTypeId: 11,
  priorityId: 3,
  assigneeId: 77,
  startDate: '2026-11-08',
};

describe('backlogIssues', () => {
  beforeEach(() => {
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
    process.env.BACKLOG_IN_PROGRESS_ON_CREATE_PROJECTS = 'OPS';
    // The writes log the issue key; keep the test output quiet
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const baseRoutes = {
    'GET /projects/OPS': { id: 5, projectKey: 'OPS', name: 'OPS' },
    'GET /projects/PROJ': { id: 1, projectKey: 'PROJ', name: 'PROJ' },
    'GET /users/myself': { id: 77, name: 'Taro Yamada' },
  };

  describe('createIssue', () => {
    test('adds the issue, sets it to In Progress in OPS and relates it', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues': [],
        'POST /issues': {
          id: 900,
          issueKey: 'OPS-12',
          summary: request.summary,
        },
        'PATCH /issues/OPS-12': { id: 900, issueKey: 'OPS-12' },
        'GET /issues/PROJ-195': { id: 195, issueKey: 'PROJ-195' },
        'POST /issues/OPS-12/relatedIssues': { id: 900 },
      });

      const result = await createIssue(
        'backlog-token',
        { ...request, relatedIssueKey: 'PROJ-195' },
        NOW
      );

      expect(result).toEqual({
        issueKey: 'OPS-12',
        url: 'https://example.backlog.jp/view/OPS-12',
        duplicate: false,
        inProgress: true,
        relatedIssueKey: 'PROJ-195',
        warnings: [],
      });
      const [add, status, relate] = writes(calls);
      expect(add.path).toBe('/issues');
      expect(Object.fromEntries(add.form)).toEqual({
        projectId: '5',
        summary: request.summary,
        description: request.description,
        issueTypeId: '11',
        priorityId: '3',
        assigneeId: '77',
        startDate: '2026-11-08',
      });
      expect(status.method).toBe('PATCH');
      // Only the status changes
      expect(Object.fromEntries(status.form)).toEqual({ statusId: '2' });
      expect(relate.path).toBe('/issues/OPS-12/relatedIssues');
      expect(Object.fromEntries(relate.form)).toEqual({ targetIssueId: '195' });
      for (const call of calls) {
        expect(call.url.host).toBe('example.backlog.jp');
      }
    });

    test('leaves the status alone outside the configured projects', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues': [],
        'POST /issues': { id: 901, issueKey: 'PROJ-300' },
      });
      const result = await createIssue(
        'backlog-token',
        { ...request, projectKey: 'PROJ' },
        NOW
      );
      expect(result.inProgress).toBe(false);
      expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /issues',
      ]);
    });

    test('returns the issue the user has just added instead of adding it again', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues': ({ url }: Call) => {
          expect(url.searchParams.getAll('createdUserId[]')).toEqual(['77']);
          return [
            {
              id: 1,
              issueKey: 'OPS-11',
              summary: request.summary,
              created: minutesAgo(2),
            },
          ];
        },
      });
      const result = await createIssue('backlog-token', request, NOW);
      expect(result).toEqual(
        expect.objectContaining({ issueKey: 'OPS-11', duplicate: true })
      );
      expect(writes(calls)).toHaveLength(0);
    });

    test('adds the issue again once the duplicate window has passed', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues': [
          {
            id: 1,
            issueKey: 'OPS-11',
            summary: request.summary,
            created: new Date(
              NOW.getTime() - DUPLICATE_WINDOW_MS - 1000
            ).toISOString(),
          },
        ],
        'POST /issues': { id: 900, issueKey: 'OPS-12' },
        'PATCH /issues/OPS-12': {},
      });
      expect((await createIssue('backlog-token', request, NOW)).issueKey).toBe(
        'OPS-12'
      );
      expect(writes(calls)[0].path).toBe('/issues');
    });

    test('reports the steps after the creation that failed', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockBacklog({
        ...baseRoutes,
        'GET /issues': [],
        'POST /issues': { id: 900, issueKey: 'OPS-12' },
        'PATCH /issues/OPS-12': 403,
        'GET /issues/PROJ-195': 404,
      });
      const result = await createIssue(
        'backlog-token',
        { ...request, relatedIssueKey: 'PROJ-195' },
        NOW
      );
      expect(result.issueKey).toBe('OPS-12');
      expect(result.inProgress).toBe(false);
      expect(result.warnings).toEqual(['in_progress_failed', 'relate_failed']);
      jest.mocked(console.warn).mockRestore();
    });
  });

  describe('addComment', () => {
    test('adds only a comment and links to it', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues/PROJ-42/comments': [
          // Someone else posted the same text
          {
            id: 10,
            content: 'Progress',
            createdUser: { id: 5 },
            created: minutesAgo(1),
          },
        ],
        'POST /issues/PROJ-42/comments': { id: 11, content: 'Progress' },
      });
      expect(
        await addComment('backlog-token', 'PROJ-42', 'Progress', NOW)
      ).toEqual({
        issueKey: 'PROJ-42',
        commentId: 11,
        url: 'https://example.backlog.jp/view/PROJ-42#comment-11',
        duplicate: false,
      });
      const [post] = writes(calls);
      expect(writes(calls)).toHaveLength(1);
      expect(Object.fromEntries(post.form)).toEqual({ content: 'Progress' });
    });

    test('returns the comment the user has just posted instead of posting it again', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /issues/PROJ-42/comments': [
          {
            id: 10,
            content: 'Progress\n',
            createdUser: { id: 77 },
            created: minutesAgo(3),
          },
        ],
      });
      expect(
        await addComment('backlog-token', 'PROJ-42', 'Progress', NOW)
      ).toEqual(expect.objectContaining({ commentId: 10, duplicate: true }));
      expect(writes(calls)).toHaveLength(0);
    });
  });

  test('getIssueDetail returns the latest comments with text, oldest first', async () => {
    mockBacklog({
      ...baseRoutes,
      'GET /issues/PROJ-42': {
        id: 206,
        issueKey: 'PROJ-42',
        summary: 'Backlog integration',
        description: 'Details',
        projectId: 1,
        issueType: { id: 11, name: 'Task' },
        priority: { id: 3, name: 'Normal' },
        status: { name: 'In Progress' },
        updated: '2026-11-07T03:00:00Z',
      },
      // Newest first, as requested
      'GET /issues/PROJ-42/comments': [
        {
          id: 3,
          content: 'Latest',
          createdUser: { id: 77, name: 'Taro' },
          created: '2026-11-07T03:00:00Z',
        },
        {
          id: 2,
          content: '',
          createdUser: { id: 77 },
          created: '2026-11-06T03:00:00Z',
        },
        {
          id: 1,
          content: 'First',
          createdUser: { id: 5, name: 'Hanako' },
          created: '2026-11-05T03:00:00Z',
        },
      ],
      'GET /projects/1': {
        id: 1,
        projectKey: 'PROJ',
        name: 'PROJ',
        textFormattingRule: 'markdown',
      },
    });
    const detail = await getIssueDetail('backlog-token', 'PROJ-42');
    expect(detail).toEqual(
      expect.objectContaining({
        issueKey: 'PROJ-42',
        projectKey: 'PROJ',
        issueTypeId: 11,
        priorityId: 3,
        textFormattingRule: 'markdown',
        myselfId: 77,
        updated: '2026-11-07',
      })
    );
    expect(detail.recentComments.map((c) => [c.id, c.url])).toEqual([
      [1, 'https://example.backlog.jp/view/PROJ-42#comment-1'],
      [3, 'https://example.backlog.jp/view/PROJ-42#comment-3'],
    ]);
  });

  test('getProjectMeta says which projects set new issues to In Progress', async () => {
    mockBacklog({
      ...baseRoutes,
      'GET /projects/5/issueTypes': [{ id: 11, name: 'Task', color: '#fff' }],
      'GET /priorities': [
        { id: 2, name: 'High' },
        { id: 3, name: 'Normal' },
      ],
      'GET /projects/5/users': [
        { id: 77, name: 'Taro Yamada', mailAddress: 'x' },
      ],
      'GET /projects/1/issueTypes': [],
      'GET /projects/1/users': [],
    });
    const meta = await getProjectMeta('backlog-token', 'OPS');
    expect(meta).toEqual({
      project: {
        id: 5,
        projectKey: 'OPS',
        name: 'OPS',
        textFormattingRule: 'markdown',
      },
      issueTypes: [{ id: 11, name: 'Task' }],
      priorities: [
        { id: 2, name: 'High' },
        { id: 3, name: 'Normal' },
      ],
      users: [{ id: 77, name: 'Taro Yamada' }],
      myself: { id: 77, name: 'Taro Yamada' },
      inProgressOnCreate: true,
    });
    expect(
      (await getProjectMeta('backlog-token', 'PROJ')).inProgressOnCreate
    ).toBe(false);
  });

  describe('request validation', () => {
    test('accepts a complete issue and drops empty optional values', () => {
      expect(
        parseCreateIssueRequest({
          ...request,
          summary: '  Renew  ',
          dueDate: '',
          relatedIssueKey: '',
        })
      ).toEqual({
        value: {
          ...request,
          summary: 'Renew',
          dueDate: undefined,
          relatedIssueKey: undefined,
        },
      });
    });

    test.each([
      [{ projectKey: 'proj' }],
      [{ projectKey: '../OPS' }],
      [{ summary: '' }],
      [{ summary: 'x'.repeat(256) }],
      [{ description: 1 }],
      [{ issueTypeId: '11' }],
      [{ priorityId: 0 }],
      [{ assigneeId: -1 }],
      [{ startDate: '2026/11/08' }],
      [{ dueDate: '2026-11-01' }],
      [{ relatedIssueKey: 'PROJ-x' }],
    ])('rejects %p', (change) => {
      expect(parseCreateIssueRequest({ ...request, ...change })).toEqual({
        error: expect.any(String),
      });
    });

    test('a comment needs text', () => {
      expect(parseCommentContent('Done')).toEqual({ value: 'Done' });
      for (const content of [undefined, '', '  ', 'x'.repeat(100_001)]) {
        expect(parseCommentContent(content)).toEqual({
          error: expect.any(String),
        });
      }
    });
  });

  describe('documents', () => {
    test('lists every document of the tree as a place to put a new one', async () => {
      const calls = mockBacklog({
        'GET /documents/tree': {
          projectId: 1,
          activeTree: {
            id: 'Active',
            children: [
              {
                id: 'd1',
                name: 'Meetings',
                emoji: '',
                children: [{ id: 'd2', name: '2026', emoji: '', children: [] }],
              },
            ],
          },
          trashTree: { id: 'Trash', children: [{ id: 'd9', name: 'Old' }] },
        },
      });
      expect(await listDocumentFolders('backlog-token', 'PROJ')).toEqual([
        { id: 'd1', path: 'Meetings' },
        { id: 'd2', path: 'Meetings / 2026' },
      ]);
      expect(calls[0].url.searchParams.get('projectIdOrKey')).toBe('PROJ');
    });

    test('adds a Markdown document without an emoji', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /documents': [],
        'POST /documents': { id: 'doc-1', title: 'Minutes' },
      });
      expect(
        await createDocument(
          'backlog-token',
          {
            projectKey: 'PROJ',
            title: 'Minutes',
            content: '## Decisions',
            parentId: 'd1',
          },
          NOW
        )
      ).toEqual({
        documentId: 'doc-1',
        title: 'Minutes',
        url: 'https://example.backlog.jp/document/PROJ/doc-1',
        duplicate: false,
      });
      const [post] = writes(calls);
      expect(Object.fromEntries(post.form)).toEqual({
        projectId: '1',
        title: 'Minutes',
        content: '## Decisions',
        parentId: 'd1',
        addLast: 'true',
      });
    });

    test('returns the document the user has just added instead of adding it again', async () => {
      const calls = mockBacklog({
        ...baseRoutes,
        'GET /documents': [
          {
            id: 'doc-1',
            title: 'Minutes',
            createdUser: { id: 77 },
            created: minutesAgo(1),
          },
        ],
      });
      expect(
        await createDocument(
          'backlog-token',
          { projectKey: 'PROJ', title: 'Minutes', content: 'x' },
          NOW
        )
      ).toEqual(
        expect.objectContaining({ documentId: 'doc-1', duplicate: true })
      );
      expect(writes(calls)).toHaveLength(0);
    });

    test('validates the request', () => {
      const ok = {
        projectKey: 'PROJ',
        title: ' Minutes ',
        content: 'x',
        parentId: '',
      };
      expect(parseCreateDocumentRequest(ok)).toEqual({
        value: {
          projectKey: 'PROJ',
          title: 'Minutes',
          content: 'x',
          parentId: undefined,
        },
      });
      for (const change of [
        { title: '' },
        { content: ' ' },
        { parentId: '../x' },
        { projectKey: 'ai' },
      ]) {
        expect(parseCreateDocumentRequest({ ...ok, ...change })).toEqual({
          error: expect.any(String),
        });
      }
    });
  });
});
