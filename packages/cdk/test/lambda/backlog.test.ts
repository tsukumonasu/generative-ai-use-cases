import {
  authorize,
  complete,
  getActivities,
  findIssues,
  getOpenTasks,
  getStatus,
  getWeeklyTasks,
  postComment,
  postIssue,
  isAllowedUser,
  resolveReturnUrl,
} from '../../lambda/backlog';
import { BacklogApiError } from '../../lambda/utils/backlogApi';
import { addComment, createIssue } from '../../lambda/utils/backlogIssues';
import {
  listMyActivities,
  listOpenTasks,
  listWeeklyTasks,
} from '../../lambda/utils/backlogTasks';
import {
  checkBacklogToken,
  completeBacklogAuthorization,
  getBacklogToken,
} from '../../lambda/utils/backlogIdentity';

jest.mock('../../lambda/utils/backlogIdentity');
// Only the Backlog reads are mocked; the date checks stay real
jest.mock('../../lambda/utils/backlogTasks', () => ({
  ...jest.requireActual('../../lambda/utils/backlogTasks'),
  listWeeklyTasks: jest.fn(),
  listOpenTasks: jest.fn(),
  listMyActivities: jest.fn(),
}));
// Only the Backlog writes are mocked; the request validation stays real
jest.mock('../../lambda/utils/backlogIssues', () => ({
  ...jest.requireActual('../../lambda/utils/backlogIssues'),
  createIssue: jest.fn(),
  addComment: jest.fn(),
}));
const mockedCreateIssue = createIssue as jest.MockedFunction<
  typeof createIssue
>;
const mockedAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockedListOpen = listOpenTasks as jest.MockedFunction<
  typeof listOpenTasks
>;
const mockedListActivities = listMyActivities as jest.MockedFunction<
  typeof listMyActivities
>;
const mockedListTasks = listWeeklyTasks as jest.MockedFunction<
  typeof listWeeklyTasks
>;
const mockedGetToken = getBacklogToken as jest.MockedFunction<
  typeof getBacklogToken
>;
const mockedCheck = checkBacklogToken as jest.MockedFunction<
  typeof checkBacklogToken
>;
const mockedComplete = completeBacklogAuthorization as jest.MockedFunction<
  typeof completeBacklogAuthorization
>;

const alice = {
  sub: 'sub-alice',
  username: 'EntraID_alice@example.co.jp',
  email: 'Alice@Example.co.jp',
};
const bob = {
  sub: 'sub-bob',
  username: 'EntraID_bob@example.co.jp',
  email: 'bob@example.co.jp',
};

const DEFAULT_ORIGIN = 'https://d111111abcdef8.cloudfront.net';
const ALIAS_ORIGIN = 'https://ai.example.net';
const CONSENT_URL =
  'https://example.backlog.jp/OAuth2AccessRequest.action?client_id=x';
const APPLICATIONS_URL = 'https://example.backlog.jp/EditApplications.action';

describe('Backlog account linking', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.BACKLOG_ALLOWED_USERS = 'entraid_alice@example.co.jp';
    process.env.BACKLOG_RETURN_ORIGINS = `${DEFAULT_ORIGIN},${ALIAS_ORIGIN}`;
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
  });

  test('allow list: listed users, "*" for everyone, empty for no one', () => {
    expect(isAllowedUser(alice)).toBe(true);
    expect(isAllowedUser(bob)).toBe(false);
    // The email is not an identity: only cognito:username is matched
    process.env.BACKLOG_ALLOWED_USERS = 'bob@example.co.jp';
    expect(isAllowedUser(bob)).toBe(false);
    process.env.BACKLOG_ALLOWED_USERS = '*';
    expect(isAllowedUser(bob)).toBe(true);
    process.env.BACKLOG_ALLOWED_USERS = '';
    expect(isAllowedUser(alice)).toBe(false);
  });

  test('consent returns to the Backlog callback on the caller origin', () => {
    expect(resolveReturnUrl('https://AI.example.net')).toBe(
      `${ALIAS_ORIGIN}/backlog/callback`
    );
    expect(resolveReturnUrl('https://evil.example.com')).toBe(
      `${DEFAULT_ORIGIN}/backlog/callback`
    );
  });

  describe('getStatus', () => {
    test('does not touch the vault for a user who is not allowed', async () => {
      expect((await getStatus(bob, DEFAULT_ORIGIN)).body).toEqual({
        allowed: false,
        linked: false,
      });
      expect(mockedGetToken).not.toHaveBeenCalled();
    });

    test('is not linked when the vault has no token', async () => {
      mockedGetToken.mockResolvedValueOnce({ authorizationUrl: CONSENT_URL });
      expect((await getStatus(alice, DEFAULT_ORIGIN)).body).toEqual({
        allowed: true,
        linked: false,
      });
      expect(mockedCheck).not.toHaveBeenCalled();
    });

    test('names the Backlog user when Backlog accepts the token', async () => {
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-token' });
      mockedCheck.mockResolvedValueOnce({
        valid: true,
        userName: 'Taro Yamada',
      });
      const res = await getStatus(alice, DEFAULT_ORIGIN);
      expect(res.body).toEqual({
        allowed: true,
        linked: true,
        userName: 'Taro Yamada',
        applicationsUrl: APPLICATIONS_URL,
      });
      expect(mockedCheck).toHaveBeenCalledWith('backlog-token');
      expect(JSON.stringify(res)).not.toContain('backlog-token');
    });

    test('reports a token Backlog rejects as expired, not linked', async () => {
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-token' });
      mockedCheck.mockResolvedValueOnce({ valid: false });
      expect((await getStatus(alice, DEFAULT_ORIGIN)).body).toEqual({
        allowed: true,
        linked: false,
        expired: true,
      });
    });

    test('keeps a stored token as linked when Backlog cannot be asked', async () => {
      jest.spyOn(console, 'warn').mockImplementationOnce(() => {});
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-token' });
      mockedCheck.mockRejectedValueOnce(new Error('Backlog returned 503'));
      expect((await getStatus(alice, DEFAULT_ORIGIN)).body).toEqual({
        allowed: true,
        linked: true,
        applicationsUrl: APPLICATIONS_URL,
      });
    });
  });

  describe('authorize', () => {
    test('is forbidden for a user who is not allowed', async () => {
      expect((await authorize(bob, DEFAULT_ORIGIN, false)).statusCode).toBe(
        403
      );
      expect(mockedGetToken).not.toHaveBeenCalled();
    });

    test('starts consent for the signed-in user, returning to the caller origin', async () => {
      mockedGetToken.mockResolvedValueOnce({ authorizationUrl: CONSENT_URL });
      const res = await authorize(alice, ALIAS_ORIGIN, true);
      expect(res.body).toEqual({
        linked: false,
        authorizationUrl: CONSENT_URL,
      });
      expect(mockedGetToken).toHaveBeenCalledWith({
        userId: 'cognito+sub-alice',
        returnUrl: `${ALIAS_ORIGIN}/backlog/callback`,
        force: true,
      });
    });
  });

  describe('complete', () => {
    test('binds the consent to the signed-in user only', async () => {
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-token' });
      const res = await complete(alice, DEFAULT_ORIGIN, 'urn:session:1');
      expect(res).toEqual({ statusCode: 200, body: { linked: true } });
      expect(mockedComplete).toHaveBeenCalledWith({
        userId: 'cognito+sub-alice',
        sessionUri: 'urn:session:1',
      });
    });

    test('rejects a missing or malformed session URI', async () => {
      for (const sessionUri of [undefined, '', 42, 'x'.repeat(2049)]) {
        expect(
          (await complete(alice, DEFAULT_ORIGIN, sessionUri)).statusCode
        ).toBe(400);
      }
      expect(mockedComplete).not.toHaveBeenCalled();
    });
  });

  describe('getWeeklyTasks', () => {
    const NOW = new Date('2026-11-08T01:00:00Z');
    const tasks = {
      today: '2026-11-08',
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      overdue: [],
      thisWeek: [],
      truncated: false,
    };

    test('is forbidden for a user who is not allowed', async () => {
      expect((await getWeeklyTasks(bob, DEFAULT_ORIGIN, NOW)).statusCode).toBe(
        403
      );
      expect(mockedGetToken).not.toHaveBeenCalled();
    });

    test('reads Backlog with the signed-in user own token', async () => {
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedListTasks.mockResolvedValueOnce(tasks);
      expect(await getWeeklyTasks(alice, DEFAULT_ORIGIN, NOW)).toEqual({
        statusCode: 200,
        body: tasks,
      });
      expect(mockedGetToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'cognito+sub-alice' })
      );
      expect(mockedListTasks).toHaveBeenCalledWith('backlog-alice', NOW);
    });

    test('asks to link Backlog when no token is stored', async () => {
      mockedGetToken.mockResolvedValueOnce({ authorizationUrl: CONSENT_URL });
      const res = await getWeeklyTasks(alice, DEFAULT_ORIGIN, NOW);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(
        expect.objectContaining({ reason: 'not_linked' })
      );
      expect(mockedListTasks).not.toHaveBeenCalled();
    });

    test('asks to link again when Backlog rejects the token', async () => {
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedListTasks.mockRejectedValueOnce(
        new BacklogApiError(401, '/users/myself')
      );
      const res = await getWeeklyTasks(alice, DEFAULT_ORIGIN, NOW);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(expect.objectContaining({ reason: 'expired' }));
    });

    test('reports other Backlog failures as a bad gateway', async () => {
      jest.spyOn(console, 'warn').mockImplementationOnce(() => {});
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedListTasks.mockRejectedValueOnce(
        new BacklogApiError(429, '/issues')
      );
      const res = await getWeeklyTasks(alice, DEFAULT_ORIGIN, NOW);
      expect(res.statusCode).toBe(502);
      expect(JSON.stringify(res)).not.toContain('backlog-alice');
    });
  });

  describe('getOpenTasks', () => {
    test("reads the signed-in user's unfinished issues", async () => {
      const NOW = new Date('2026-11-08T01:00:00Z');
      const body = {
        today: '2026-11-08',
        stalledDays: 14,
        tasks: [],
        truncated: false,
      };
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedListOpen.mockResolvedValueOnce(body);
      expect(await getOpenTasks(alice, DEFAULT_ORIGIN, NOW)).toEqual({
        statusCode: 200,
        body,
      });
      expect(mockedListOpen).toHaveBeenCalledWith('backlog-alice', NOW);
    });
  });

  describe('getActivities', () => {
    const NOW = new Date('2026-11-08T01:00:00Z');

    test('reads the activities since the given day', async () => {
      const body = {
        since: '2026-11-01',
        today: '2026-11-08',
        issues: [],
        truncated: false,
      };
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedListActivities.mockResolvedValueOnce(body);
      expect(
        await getActivities(alice, DEFAULT_ORIGIN, '2026-11-01', NOW)
      ).toEqual({ statusCode: 200, body });
      expect(mockedListActivities).toHaveBeenCalledWith(
        'backlog-alice',
        '2026-11-01',
        NOW
      );
    });

    test('rejects a day that is malformed, in the future or too old', async () => {
      for (const since of [
        undefined,
        ['2026-11-01'],
        '2026-11-09',
        '2026-01-01',
      ]) {
        expect(
          (await getActivities(alice, DEFAULT_ORIGIN, since, NOW)).statusCode
        ).toBe(400);
      }
      expect(mockedGetToken).not.toHaveBeenCalled();
    });
  });

  describe('registering', () => {
    const issue = {
      projectKey: 'PROJ',
      summary: 'Try the Backlog page',
      description: 'Details',
      issueTypeId: 11,
      priorityId: 3,
    };

    test('adds an issue as the signed-in user', async () => {
      const created = {
        issueKey: 'PROJ-300',
        url: 'https://example.backlog.jp/view/PROJ-300',
        duplicate: false,
        inProgress: false,
        warnings: [],
      };
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedCreateIssue.mockResolvedValueOnce(created);
      expect(await postIssue(alice, DEFAULT_ORIGIN, issue)).toEqual({
        statusCode: 200,
        body: created,
      });
      expect(mockedCreateIssue).toHaveBeenCalledWith(
        'backlog-alice',
        expect.objectContaining(issue)
      );
    });

    test('rejects an invalid request before reading the vault', async () => {
      expect(
        (await postIssue(alice, DEFAULT_ORIGIN, { ...issue, summary: '' }))
          .statusCode
      ).toBe(400);
      expect(
        (await postComment(alice, DEFAULT_ORIGIN, 'PROJ-1', '')).statusCode
      ).toBe(400);
      expect(
        (await postComment(alice, DEFAULT_ORIGIN, '../PROJ-1', 'Hi')).statusCode
      ).toBe(400);
      expect(
        (await findIssues(alice, DEFAULT_ORIGIN, 'ai', '')).statusCode
      ).toBe(400);
      expect(mockedGetToken).not.toHaveBeenCalled();
    });

    test('is forbidden for a user who is not allowed', async () => {
      expect((await postIssue(bob, DEFAULT_ORIGIN, issue)).statusCode).toBe(
        403
      );
      expect(mockedCreateIssue).not.toHaveBeenCalled();
    });

    test('passes on what Backlog refused so the user can act on it', async () => {
      jest.spyOn(console, 'warn').mockImplementationOnce(() => {});
      mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-alice' });
      mockedAddComment.mockRejectedValueOnce(
        new BacklogApiError(404, '/issues/PROJ-1/comments')
      );
      expect(
        (await postComment(alice, DEFAULT_ORIGIN, 'PROJ-1', 'Hi')).statusCode
      ).toBe(404);
    });
  });
});
