import {
  BacklogAddCommentResponse,
  BacklogComment,
  BacklogCreateDocumentRequest,
  BacklogCreateDocumentResponse,
  BacklogCreateIssueRequest,
  BacklogDocumentFolder,
  BacklogCreateIssueResponse,
  BacklogIssueDetail,
  BacklogIssueSummary,
  BacklogNamedItem,
  BacklogProjectMeta,
  BacklogProjectSummary,
} from 'generative-ai-use-cases';
import {
  backlogCommentUrl,
  backlogDocumentUrl,
  backlogGet,
  backlogIssueUrl,
  backlogPatch,
  backlogPost,
} from './backlogApi';
import { japanDate } from './backlogTasks';

// Registering in Backlog from the Backlog page. The page drafts
// with a model and calls these only when the user presses the register
// button; the model itself has no way to write to Backlog. Only these writes
// exist: add an issue (and set it to In Progress in the configured projects,
// relate it to another issue), add a comment, and add a document. Backlog has
// no API to update a document, so documents are only ever added.

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SUMMARY_LENGTH = 255;
export const MAX_TEXT_LENGTH = 100_000;
const MAX_KEYWORD_LENGTH = 100;

// The default status In Progress has this ID in every project
export const IN_PROGRESS_STATUS_ID = 2;

// A second click, or a retry after a timeout, within this time returns what
// was already registered instead of registering it again
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const SEARCH_COUNT = 20;
const RECENT_COMMENT_COUNT = 20;

type RawProject = {
  id: number;
  projectKey: string;
  name: string;
  textFormattingRule?: string;
};
type RawNamed = { id: number; name: string };
type RawIssue = {
  id: number;
  issueKey: string;
  summary: string;
  description?: string | null;
  projectId: number;
  issueType?: { id?: number; name?: string } | null;
  status?: { name?: string } | null;
  priority?: { id?: number; name?: string } | null;
  updated?: string | null;
  created?: string | null;
};
type RawComment = {
  id: number;
  content?: string | null;
  createdUser?: { id?: number; name?: string } | null;
  created: string;
};

/** Projects whose new issues are set to In Progress right after creation. */
export const inProgressOnCreateProjects = (): string[] =>
  (process.env.BACKLOG_IN_PROGRESS_ON_CREATE_PROJECTS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

const toProject = (project: RawProject): BacklogProjectSummary => ({
  id: project.id,
  projectKey: project.projectKey,
  name: project.name,
  textFormattingRule:
    project.textFormattingRule === 'backlog' ? 'backlog' : 'markdown',
});

const toNamed = (item: RawNamed): BacklogNamedItem => ({
  id: item.id,
  name: item.name,
});

const toIssueSummary = (issue: RawIssue): BacklogIssueSummary => ({
  issueKey: issue.issueKey,
  summary: issue.summary,
  url: backlogIssueUrl(issue.issueKey),
  status: issue.status?.name ?? '',
  issueType: issue.issueType?.name ?? '',
  updated: issue.updated ? japanDate(new Date(issue.updated)) : '',
});

const getProject = (accessToken: string, projectKey: string) =>
  backlogGet<RawProject>(
    accessToken,
    `/projects/${encodeURIComponent(projectKey)}`
  );

const getMyself = (accessToken: string) =>
  backlogGet<RawNamed>(accessToken, '/users/myself');

/** The projects the user belongs to, in key order. */
export const listProjects = async (
  accessToken: string
): Promise<BacklogProjectSummary[]> =>
  (
    await backlogGet<RawProject[]>(accessToken, '/projects', {
      archived: 'false',
    })
  )
    .map(toProject)
    .sort((a, b) => a.projectKey.localeCompare(b.projectKey));

/** The issue types, priorities and members a new issue can be set to. */
export const getProjectMeta = async (
  accessToken: string,
  projectKey: string
): Promise<BacklogProjectMeta> => {
  const project = await getProject(accessToken, projectKey);
  const [issueTypes, priorities, users, myself] = await Promise.all([
    backlogGet<RawNamed[]>(accessToken, `/projects/${project.id}/issueTypes`),
    backlogGet<RawNamed[]>(accessToken, '/priorities'),
    backlogGet<RawNamed[]>(accessToken, `/projects/${project.id}/users`),
    getMyself(accessToken),
  ]);
  return {
    project: toProject(project),
    issueTypes: issueTypes.map(toNamed),
    priorities: priorities.map(toNamed),
    users: users.map(toNamed),
    myself: toNamed(myself),
    inProgressOnCreate: inProgressOnCreateProjects().includes(
      project.projectKey
    ),
  };
};

/** Issues of the project matching the keyword, recently updated first. */
export const searchIssues = async (
  accessToken: string,
  projectKey: string,
  keyword: string
): Promise<BacklogIssueSummary[]> => {
  const project = await getProject(accessToken, projectKey);
  const issues = await backlogGet<RawIssue[]>(accessToken, '/issues', {
    projectId: [project.id],
    keyword: keyword || undefined,
    sort: 'updated',
    order: 'desc',
    count: SEARCH_COUNT,
  });
  return issues.map(toIssueSummary);
};

const toComment = (issueKey: string, comment: RawComment): BacklogComment => ({
  id: comment.id,
  content: comment.content ?? '',
  createdUserId: comment.createdUser?.id,
  createdUserName: comment.createdUser?.name ?? '',
  created: comment.created,
  url: backlogCommentUrl(issueKey, comment.id),
});

/** An issue with its latest comments, as source material for a draft. */
export const getIssueDetail = async (
  accessToken: string,
  issueKey: string
): Promise<BacklogIssueDetail> => {
  const path = `/issues/${encodeURIComponent(issueKey)}`;
  const [issue, comments, myself] = await Promise.all([
    backlogGet<RawIssue>(accessToken, path),
    backlogGet<RawComment[]>(accessToken, `${path}/comments`, {
      count: RECENT_COMMENT_COUNT,
      order: 'desc',
    }),
    getMyself(accessToken),
  ]);
  const project = await backlogGet<RawProject>(
    accessToken,
    `/projects/${issue.projectId}`
  );
  return {
    ...toIssueSummary(issue),
    projectKey: project.projectKey,
    description: issue.description ?? '',
    issueTypeId: issue.issueType?.id,
    priorityId: issue.priority?.id,
    priority: issue.priority?.name ?? '',
    textFormattingRule: toProject(project).textFormattingRule,
    // Status changes without text are comments too; leave them out
    recentComments: comments
      .filter((comment) => !!comment.content?.trim())
      .reverse()
      .map((comment) => toComment(issue.issueKey, comment)),
    myselfId: myself.id,
  };
};

const isRecent = (created: string | null | undefined, now: Date) =>
  !!created && now.getTime() - Date.parse(created) < DUPLICATE_WINDOW_MS;

/**
 * Add an issue as the user, then set it to In Progress in the configured
 * projects and relate it to `relatedIssueKey`. When the user has just added
 * an issue with the same summary, that issue is returned instead.
 */
export const createIssue = async (
  accessToken: string,
  input: BacklogCreateIssueRequest,
  now: Date = new Date()
): Promise<BacklogCreateIssueResponse> => {
  const [project, myself] = await Promise.all([
    getProject(accessToken, input.projectKey),
    getMyself(accessToken),
  ]);

  const recent = await backlogGet<RawIssue[]>(accessToken, '/issues', {
    projectId: [project.id],
    createdUserId: [myself.id],
    createdSince: japanDate(new Date(now.getTime() - DUPLICATE_WINDOW_MS)),
    sort: 'created',
    order: 'desc',
    count: SEARCH_COUNT,
  });
  const duplicate = recent.find(
    (issue) => issue.summary === input.summary && isRecent(issue.created, now)
  );
  if (duplicate) {
    return {
      issueKey: duplicate.issueKey,
      url: backlogIssueUrl(duplicate.issueKey),
      duplicate: true,
      inProgress: false,
      warnings: [],
    };
  }

  const created = await backlogPost<RawIssue>(accessToken, '/issues', {
    projectId: project.id,
    summary: input.summary,
    description: input.description,
    issueTypeId: input.issueTypeId,
    priorityId: input.priorityId,
    assigneeId: input.assigneeId,
    startDate: input.startDate,
    dueDate: input.dueDate,
  });
  console.log(`Backlog issue added: ${created.issueKey}`);

  const warnings: BacklogCreateIssueResponse['warnings'] = [];
  let inProgress = false;
  if (inProgressOnCreateProjects().includes(project.projectKey)) {
    try {
      await backlogPatch(
        accessToken,
        `/issues/${encodeURIComponent(created.issueKey)}`,
        { statusId: IN_PROGRESS_STATUS_ID }
      );
      inProgress = true;
    } catch (error) {
      console.warn(
        'Could not set the new issue to In Progress:',
        error instanceof Error ? error.message : typeof error
      );
      warnings.push('in_progress_failed');
    }
  }

  let relatedIssueKey: string | undefined;
  if (input.relatedIssueKey) {
    try {
      const target = await backlogGet<RawIssue>(
        accessToken,
        `/issues/${encodeURIComponent(input.relatedIssueKey)}`
      );
      await backlogPost(
        accessToken,
        `/issues/${encodeURIComponent(created.issueKey)}/relatedIssues`,
        { targetIssueId: target.id }
      );
      relatedIssueKey = input.relatedIssueKey;
    } catch (error) {
      console.warn(
        'Could not relate the new issue:',
        error instanceof Error ? error.message : typeof error
      );
      warnings.push('relate_failed');
    }
  }

  return {
    issueKey: created.issueKey,
    url: backlogIssueUrl(created.issueKey),
    duplicate: false,
    inProgress,
    relatedIssueKey,
    warnings,
  };
};

/**
 * Add a comment to an issue as the user. Nothing else of the issue changes.
 * When the user has just posted the same comment, that one is returned.
 */
export const addComment = async (
  accessToken: string,
  issueKey: string,
  content: string,
  now: Date = new Date()
): Promise<BacklogAddCommentResponse> => {
  const path = `/issues/${encodeURIComponent(issueKey)}/comments`;
  const [myself, recent] = await Promise.all([
    getMyself(accessToken),
    backlogGet<RawComment[]>(accessToken, path, {
      count: RECENT_COMMENT_COUNT,
      order: 'desc',
    }),
  ]);
  const duplicate = recent.find(
    (comment) =>
      comment.createdUser?.id === myself.id &&
      comment.content?.trim() === content.trim() &&
      isRecent(comment.created, now)
  );
  if (duplicate) {
    return {
      issueKey,
      commentId: duplicate.id,
      url: backlogCommentUrl(issueKey, duplicate.id),
      duplicate: true,
    };
  }

  const comment = await backlogPost<RawComment>(accessToken, path, {
    content,
  });
  console.log(`Backlog comment added: ${issueKey}#comment-${comment.id}`);
  return {
    issueKey,
    commentId: comment.id,
    url: backlogCommentUrl(issueKey, comment.id),
    duplicate: false,
  };
};

// ---------- Request validation ----------

type Parsed<T> = { value: T } | { error: string };

const optionalDay = (value: unknown): string | undefined | null => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return typeof value === 'string' &&
    DAY_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ? value
    : null;
};

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

export const parseCreateIssueRequest = (
  body: unknown
): Parsed<BacklogCreateIssueRequest> => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (
    typeof b.projectKey !== 'string' ||
    !PROJECT_KEY_PATTERN.test(b.projectKey)
  ) {
    return { error: 'projectKey is invalid' };
  }
  const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
  if (!summary || summary.length > MAX_SUMMARY_LENGTH) {
    return { error: `summary must be 1-${MAX_SUMMARY_LENGTH} characters` };
  }
  if (
    typeof b.description !== 'string' ||
    b.description.length > MAX_TEXT_LENGTH
  ) {
    return {
      error: `description must be at most ${MAX_TEXT_LENGTH} characters`,
    };
  }
  if (!isId(b.issueTypeId) || !isId(b.priorityId)) {
    return { error: 'issueTypeId and priorityId are required' };
  }
  if (
    b.assigneeId !== undefined &&
    b.assigneeId !== null &&
    !isId(b.assigneeId)
  ) {
    return { error: 'assigneeId is invalid' };
  }
  const startDate = optionalDay(b.startDate);
  const dueDate = optionalDay(b.dueDate);
  if (startDate === null || dueDate === null) {
    return { error: 'startDate and dueDate must be YYYY-MM-DD' };
  }
  if (startDate && dueDate && dueDate < startDate) {
    return { error: 'dueDate must not be before startDate' };
  }
  if (
    b.relatedIssueKey !== undefined &&
    b.relatedIssueKey !== null &&
    b.relatedIssueKey !== '' &&
    (typeof b.relatedIssueKey !== 'string' ||
      !ISSUE_KEY_PATTERN.test(b.relatedIssueKey))
  ) {
    return { error: 'relatedIssueKey is invalid' };
  }
  return {
    value: {
      projectKey: b.projectKey,
      summary,
      description: b.description,
      issueTypeId: b.issueTypeId,
      priorityId: b.priorityId,
      assigneeId: isId(b.assigneeId) ? b.assigneeId : undefined,
      startDate,
      dueDate,
      relatedIssueKey:
        typeof b.relatedIssueKey === 'string' && b.relatedIssueKey
          ? b.relatedIssueKey
          : undefined,
    },
  };
};

export const parseCommentContent = (content: unknown): Parsed<string> => {
  if (typeof content !== 'string' || !content.trim()) {
    return { error: 'content is required' };
  }
  if (content.length > MAX_TEXT_LENGTH) {
    return { error: `content must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  return { value: content };
};

export const parseKeyword = (keyword: unknown): Parsed<string> => {
  if (keyword === undefined) {
    return { value: '' };
  }
  if (typeof keyword !== 'string' || keyword.length > MAX_KEYWORD_LENGTH) {
    return { error: 'keyword is invalid' };
  }
  return { value: keyword.trim() };
};

// ---------- Documents ----------

type RawDocumentNode = {
  id: string;
  name?: string;
  children?: RawDocumentNode[];
};
type RawDocument = {
  id: string;
  title?: string;
  createdUser?: { id?: number } | null;
  created?: string;
};

const MAX_FOLDERS = 500;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Every document of the project as a place to put a new one under. */
export const listDocumentFolders = async (
  accessToken: string,
  projectKey: string
): Promise<BacklogDocumentFolder[]> => {
  const tree = await backlogGet<{ activeTree?: RawDocumentNode }>(
    accessToken,
    '/documents/tree',
    { projectIdOrKey: projectKey }
  );
  const folders: BacklogDocumentFolder[] = [];
  const walk = (nodes: RawDocumentNode[], parents: string[]) => {
    for (const node of nodes) {
      if (folders.length >= MAX_FOLDERS) return;
      const path = [...parents, node.name ?? ''];
      folders.push({ id: node.id, path: path.join(' / ') });
      walk(node.children ?? [], path);
    }
  };
  walk(tree.activeTree?.children ?? [], []);
  return folders;
};

/**
 * Add a document (Markdown, no emoji) as the user. When the user has just
 * added a document with the same title, that one is returned instead.
 */
export const createDocument = async (
  accessToken: string,
  input: BacklogCreateDocumentRequest,
  now: Date = new Date()
): Promise<BacklogCreateDocumentResponse> => {
  const [project, myself] = await Promise.all([
    getProject(accessToken, input.projectKey),
    getMyself(accessToken),
  ]);
  const recent = await backlogGet<RawDocument[]>(accessToken, '/documents', {
    projectId: [project.id],
    keyword: input.title,
    sort: 'created',
    order: 'desc',
    offset: 0,
    count: SEARCH_COUNT,
  });
  const duplicate = recent.find(
    (doc) =>
      doc.title === input.title &&
      doc.createdUser?.id === myself.id &&
      isRecent(doc.created, now)
  );
  if (duplicate) {
    return {
      documentId: duplicate.id,
      title: input.title,
      url: backlogDocumentUrl(project.projectKey, duplicate.id),
      duplicate: true,
    };
  }

  // Emoji are never sent: some of them make Backlog answer 400
  const created = await backlogPost<RawDocument>(accessToken, '/documents', {
    projectId: project.id,
    title: input.title,
    content: input.content,
    parentId: input.parentId,
    addLast: 'true',
  });
  console.log(`Backlog document added: ${project.projectKey}/${created.id}`);
  return {
    documentId: created.id,
    title: input.title,
    url: backlogDocumentUrl(project.projectKey, created.id),
    duplicate: false,
  };
};

export const parseCreateDocumentRequest = (
  body: unknown
): Parsed<BacklogCreateDocumentRequest> => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (
    typeof b.projectKey !== 'string' ||
    !PROJECT_KEY_PATTERN.test(b.projectKey)
  ) {
    return { error: 'projectKey is invalid' };
  }
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > MAX_SUMMARY_LENGTH) {
    return { error: `title must be 1-${MAX_SUMMARY_LENGTH} characters` };
  }
  if (
    typeof b.content !== 'string' ||
    !b.content.trim() ||
    b.content.length > MAX_TEXT_LENGTH
  ) {
    return { error: `content must be 1-${MAX_TEXT_LENGTH} characters` };
  }
  if (
    b.parentId !== undefined &&
    b.parentId !== null &&
    b.parentId !== '' &&
    (typeof b.parentId !== 'string' || !DOCUMENT_ID_PATTERN.test(b.parentId))
  ) {
    return { error: 'parentId is invalid' };
  }
  return {
    value: {
      projectKey: b.projectKey,
      title,
      content: b.content,
      parentId:
        typeof b.parentId === 'string' && b.parentId ? b.parentId : undefined,
    },
  };
};
