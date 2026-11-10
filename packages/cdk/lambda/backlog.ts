import {
  BacklogAuthorizeResponse,
  BacklogCompleteResponse,
  BacklogErrorResponse,
  BacklogStatusResponse,
  BacklogActivitiesResponse,
  BacklogAddCommentResponse,
  BacklogCreateDocumentResponse,
  BacklogCreateIssueResponse,
  BacklogDocumentFolder,
  BacklogGanttResponse,
  BacklogIssueDetail,
  BacklogMembersResponse,
  BacklogIssueSummary,
  BacklogOpenTasksResponse,
  BacklogProjectMeta,
  BacklogProjectSummary,
  BacklogWeeklyTasksResponse,
} from 'generative-ai-use-cases';
import { BacklogApiError, backlogApplicationsUrl } from './utils/backlogApi';
import {
  ISSUE_KEY_PATTERN,
  PROJECT_KEY_PATTERN,
  addComment,
  createDocument,
  createIssue,
  getIssueDetail,
  getProjectMeta,
  listDocumentFolders,
  listProjects,
  parseCommentContent,
  parseCreateDocumentRequest,
  parseCreateIssueRequest,
  parseKeyword,
  searchIssues,
} from './utils/backlogIssues';
import {
  listGanttIssues,
  listMembers,
  parseGanttQuery,
} from './utils/backlogGantt';
import {
  MAX_ACTIVITY_DAYS,
  isValidActivitySince,
  listMyActivities,
  listOpenTasks,
  listWeeklyTasks,
} from './utils/backlogTasks';
import {
  checkBacklogToken,
  completeBacklogAuthorization,
  getBacklogToken,
} from './utils/backlogIdentity';
import {
  IntegrationUser,
  isUserInAllowList,
  resolveIntegrationReturnUrl,
  vaultUserId,
} from './utils/userIntegration';

// Business logic of the /backlog API (routes in api/routes/backlog.ts). Each
// user links their own Backlog account; the tokens stay in the AgentCore
// Identity Token Vault and are used only on the server.

export const BACKLOG_CALLBACK_PATH = '/backlog/callback';

export type BacklogUser = IntegrationUser;

export type BacklogResult<T> = {
  statusCode: number;
  body: T | BacklogErrorResponse;
};

export const isBacklogConfigured = (): boolean =>
  !!process.env.BACKLOG_WORKLOAD_NAME;

/**
 * Whether the user is in backlogAllowedUsers (cognito:username,
 * case-insensitive). "*" allows every signed-in user.
 */
export const isAllowedUser = (user: BacklogUser): boolean =>
  isUserInAllowList('BACKLOG_ALLOWED_USERS', user);

/**
 * The page the browser returns to after Backlog consent, on the origin the
 * user started from (see resolveIntegrationReturnUrl).
 */
export const resolveReturnUrl = (origin: string | undefined): string =>
  resolveIntegrationReturnUrl(
    'BACKLOG_RETURN_ORIGINS',
    BACKLOG_CALLBACK_PATH,
    origin
  );

const forbidden = (): BacklogResult<never> => ({
  statusCode: 403,
  body: { message: 'You are not allowed to use the Backlog integration' },
});

const notLinked = (): BacklogResult<never> => ({
  statusCode: 409,
  body: { message: 'Link your Backlog account first', reason: 'not_linked' },
});

/**
 * Whether the user has linked Backlog. A stored token is checked against
 * Backlog itself, so a token the vault keeps but Backlog no longer accepts
 * (revoked, or not refreshed) shows as expired instead of linked.
 */
export const getStatus = async (
  user: BacklogUser,
  origin: string | undefined
): Promise<BacklogResult<BacklogStatusResponse>> => {
  if (!isAllowedUser(user)) {
    return { statusCode: 200, body: { allowed: false, linked: false } };
  }
  const token = await getBacklogToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  if (!('accessToken' in token)) {
    return { statusCode: 200, body: { allowed: true, linked: false } };
  }
  const applicationsUrl = backlogApplicationsUrl();
  try {
    const check = await checkBacklogToken(token.accessToken);
    return {
      statusCode: 200,
      body: check.valid
        ? {
            allowed: true,
            linked: true,
            userName: check.userName,
            applicationsUrl,
          }
        : { allowed: true, linked: false, expired: true },
    };
  } catch (error) {
    // Backlog could not be asked; the token itself may be fine
    console.warn(
      'Could not check the Backlog token:',
      error instanceof Error ? error.message : typeof error
    );
    return {
      statusCode: 200,
      body: { allowed: true, linked: true, applicationsUrl },
    };
  }
};

export const authorize = async (
  user: BacklogUser,
  origin: string | undefined,
  force: boolean
): Promise<BacklogResult<BacklogAuthorizeResponse>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  const token = await getBacklogToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
    force,
  });
  return {
    statusCode: 200,
    body:
      'accessToken' in token
        ? { linked: true }
        : { linked: false, authorizationUrl: token.authorizationUrl },
  };
};

export const complete = async (
  user: BacklogUser,
  origin: string | undefined,
  sessionUri: unknown
): Promise<BacklogResult<BacklogCompleteResponse>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  if (
    typeof sessionUri !== 'string' ||
    sessionUri.length === 0 ||
    sessionUri.length > 2048
  ) {
    return { statusCode: 400, body: { message: 'sessionUri is required' } };
  }
  await completeBacklogAuthorization({
    userId: vaultUserId(user),
    sessionUri,
  });
  const token = await getBacklogToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  return { statusCode: 200, body: { linked: 'accessToken' in token } };
};

const linkAgain = (): BacklogResult<never> => ({
  statusCode: 409,
  body: {
    message: 'Backlog rejected the token. Link Backlog again.',
    reason: 'expired',
  },
});

const badRequest = (message: string): BacklogResult<never> => ({
  statusCode: 400,
  body: { message },
});

/**
 * Run `call` with the user's Backlog token on the server side (the token is
 * not returned). Backlog refusing the token asks the user to link again.
 */
const withUserToken = async <T>(
  user: BacklogUser,
  origin: string | undefined,
  call: (accessToken: string) => Promise<T>
): Promise<BacklogResult<T>> => {
  if (!isAllowedUser(user)) {
    return forbidden();
  }
  const token = await getBacklogToken({
    userId: vaultUserId(user),
    returnUrl: resolveReturnUrl(origin),
  });
  if (!('accessToken' in token)) {
    return notLinked();
  }
  try {
    return { statusCode: 200, body: await call(token.accessToken) };
  } catch (error) {
    if (!(error instanceof BacklogApiError)) {
      throw error;
    }
    if (error.status === 401) {
      return linkAgain();
    }
    console.warn(error.message);
    // Not found, no permission or a value Backlog rejected: the user can act
    // on these, so they keep their status
    if ([400, 403, 404].includes(error.status)) {
      return { statusCode: error.status, body: { message: error.message } };
    }
    return { statusCode: 502, body: { message: error.message } };
  }
};

/** The user's unfinished issues due by the end of this week. */
export const getWeeklyTasks = (
  user: BacklogUser,
  origin: string | undefined,
  now: Date = new Date()
): Promise<BacklogResult<BacklogWeeklyTasksResponse>> =>
  withUserToken(user, origin, (token) => listWeeklyTasks(token, now));

/** Every unfinished issue of the user, stalled ones marked. */
export const getOpenTasks = (
  user: BacklogUser,
  origin: string | undefined,
  now: Date = new Date()
): Promise<BacklogResult<BacklogOpenTasksResponse>> =>
  withUserToken(user, origin, (token) => listOpenTasks(token, now));

/** What the user did on issues since `since` (YYYY-MM-DD in Japan). */
export const getActivities = async (
  user: BacklogUser,
  origin: string | undefined,
  since: unknown,
  now: Date = new Date()
): Promise<BacklogResult<BacklogActivitiesResponse>> => {
  if (!isValidActivitySince(since, now)) {
    return {
      statusCode: 400,
      body: {
        message: `since must be a day (YYYY-MM-DD) within the last ${MAX_ACTIVITY_DAYS} days`,
      },
    };
  }
  return withUserToken(user, origin, (token) =>
    listMyActivities(token, since as string, now)
  );
};

/** The members of the user's projects, for picking whom the chart shows. */
export const getMembers = (
  user: BacklogUser,
  origin: string | undefined
): Promise<BacklogResult<BacklogMembersResponse>> =>
  withUserToken(user, origin, listMembers);

/** The gantt chart of the people's issues over a period. */
export const getGantt = async (
  user: BacklogUser,
  origin: string | undefined,
  query: Record<string, unknown>,
  now: Date = new Date()
): Promise<BacklogResult<BacklogGanttResponse>> => {
  const parsed = parseGanttQuery(query);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }
  return withUserToken(user, origin, (token) =>
    listGanttIssues(token, parsed.value, now)
  );
};

// ---------- Registering in Backlog ----------
// Called by the Backlog page only when the user presses the register button.

export const getProjects = (
  user: BacklogUser,
  origin: string | undefined
): Promise<BacklogResult<BacklogProjectSummary[]>> =>
  withUserToken(user, origin, listProjects);

export const getProject = async (
  user: BacklogUser,
  origin: string | undefined,
  projectKey: string
): Promise<BacklogResult<BacklogProjectMeta>> => {
  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    return badRequest('projectKey is invalid');
  }
  return withUserToken(user, origin, (token) =>
    getProjectMeta(token, projectKey)
  );
};

export const findIssues = async (
  user: BacklogUser,
  origin: string | undefined,
  projectKey: unknown,
  keyword: unknown
): Promise<BacklogResult<BacklogIssueSummary[]>> => {
  if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
    return badRequest('projectKey is invalid');
  }
  const parsed = parseKeyword(keyword);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }
  return withUserToken(user, origin, (token) =>
    searchIssues(token, projectKey, parsed.value)
  );
};

export const getIssue = async (
  user: BacklogUser,
  origin: string | undefined,
  issueKey: string
): Promise<BacklogResult<BacklogIssueDetail>> => {
  if (!ISSUE_KEY_PATTERN.test(issueKey)) {
    return badRequest('issueKey is invalid');
  }
  return withUserToken(user, origin, (token) =>
    getIssueDetail(token, issueKey)
  );
};

export const postIssue = async (
  user: BacklogUser,
  origin: string | undefined,
  body: unknown
): Promise<BacklogResult<BacklogCreateIssueResponse>> => {
  const parsed = parseCreateIssueRequest(body);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }
  return withUserToken(user, origin, (token) =>
    createIssue(token, parsed.value)
  );
};

export const postComment = async (
  user: BacklogUser,
  origin: string | undefined,
  issueKey: string,
  content: unknown
): Promise<BacklogResult<BacklogAddCommentResponse>> => {
  if (!ISSUE_KEY_PATTERN.test(issueKey)) {
    return badRequest('issueKey is invalid');
  }
  const parsed = parseCommentContent(content);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }
  return withUserToken(user, origin, (token) =>
    addComment(token, issueKey, parsed.value)
  );
};

export const getDocumentFolders = async (
  user: BacklogUser,
  origin: string | undefined,
  projectKey: string
): Promise<BacklogResult<BacklogDocumentFolder[]>> => {
  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    return badRequest('projectKey is invalid');
  }
  return withUserToken(user, origin, (token) =>
    listDocumentFolders(token, projectKey)
  );
};

export const postDocument = async (
  user: BacklogUser,
  origin: string | undefined,
  body: unknown
): Promise<BacklogResult<BacklogCreateDocumentResponse>> => {
  const parsed = parseCreateDocumentRequest(body);
  if ('error' in parsed) {
    return badRequest(parsed.error);
  }
  return withUserToken(user, origin, (token) =>
    createDocument(token, parsed.value)
  );
};
