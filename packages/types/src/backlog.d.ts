// The Backlog page and its account linking (lambda/backlog.ts). Backlog OAuth
// tokens are kept in the AgentCore Identity Token Vault and used only on the
// server side, behind the Cognito-authorized /backlog API.

export type BacklogStatusResponse = {
  // Whether the signed-in user may use the integration (backlogAllowedUsers)
  allowed: boolean;
  // Whether a Backlog token is stored for the user and Backlog accepted it
  linked: boolean;
  // A token is stored but Backlog rejected it (e.g. the user revoked the
  // access, or it could not be refreshed). The user has to link again.
  expired?: boolean;
  // The Backlog user the token belongs to, when linked
  userName?: string;
  // When linked: Backlog's personal settings page listing the authorized
  // apps, where the user unlinks GenU (Backlog has no API to revoke a token)
  applicationsUrl?: string;
};

export type BacklogAuthorizeRequest = {
  // Start a new consent even when a token is already stored (e.g. to switch
  // to another Backlog account or to replace a token Backlog rejects)
  force?: boolean;
};

export type BacklogAuthorizeResponse =
  | { linked: true }
  | { linked: false; authorizationUrl: string };

export type BacklogCompleteRequest = {
  // The session_id query parameter AgentCore Identity appends to the return URL
  sessionUri: string;
};

export type BacklogCompleteResponse = {
  linked: boolean;
};

// Why a /backlog request needs the user to link Backlog (again)
export type BacklogErrorReason =
  // No token is stored for the user
  | 'not_linked'
  // A token is stored but Backlog rejected it
  | 'expired';

export type BacklogErrorResponse = {
  message: string;
  reason?: BacklogErrorReason;
};

// One unfinished issue assigned to the user (GET /backlog/tasks and
// /backlog/my-issues)
export type BacklogTask = {
  issueKey: string;
  summary: string;
  // https://<space>/view/<issueKey>
  url: string;
  projectKey: string;
  projectName: string;
  issueType: string;
  status: string;
  priority: string;
  // YYYY-MM-DD
  startDate?: string;
  dueDate?: string;
  // The day the issue was last updated, YYYY-MM-DD in Japan
  updated: string;
  // Not updated for BACKLOG_STALLED_DAYS days or more
  stalled: boolean;
};

// The signed-in user's unfinished issues (every status except Closed) that
// are due by the end of this week, Monday to Sunday in Japan
export type BacklogWeeklyTasksResponse = {
  // YYYY-MM-DD in Japan
  today: string;
  weekStart: string;
  weekEnd: string;
  // Due before today
  overdue: BacklogTask[];
  // Due from today to the end of the week
  thisWeek: BacklogTask[];
  // More issues matched than the list holds
  truncated: boolean;
};

// Every unfinished issue assigned to the signed-in user, soonest due first
// (issues without a due date last)
export type BacklogOpenTasksResponse = {
  today: string;
  // Days without an update after which an issue counts as stalled
  stalledDays: number;
  tasks: BacklogTask[];
  truncated: boolean;
};

// What the signed-in user did on one issue since a day
export type BacklogIssueActivity = {
  issueKey: string;
  summary: string;
  url: string;
  projectKey: string;
  projectName: string;
  // The user added the issue
  created: boolean;
  // The user changed its status and it is Closed now
  completed: boolean;
  // Comments the user wrote
  comments: { id: number; url: string }[];
  // Fields the user changed (Backlog field names, e.g. "status", "limitDate")
  updatedFields: string[];
  // Its status now, when Backlog returned it
  status?: string;
  // ISO 8601
  lastActivity: string;
};

// GET /backlog/activities?since=YYYY-MM-DD
export type BacklogActivitiesResponse = {
  // YYYY-MM-DD in Japan
  since: string;
  today: string;
  // Most recent first
  issues: BacklogIssueActivity[];
  // More activities happened than were read
  truncated: boolean;
};

// ---------- Gantt chart (the Backlog page) ----------

// Someone whose issues the gantt chart can show: a member of a project the
// signed-in user belongs to (GET /backlog/members)
export type BacklogMember = {
  // Backlog's numeric user ID (assigneeId)
  id: number;
  name: string;
  // Login ID
  userId?: string;
  mailAddress?: string;
  // Projects (keys) of the signed-in user the person is a member of
  projectKeys: string[];
};

export type BacklogMembersResponse = {
  myself: BacklogMember;
  // In name order, the signed-in user included
  members: BacklogMember[];
};

// One issue on the gantt chart
export type BacklogGanttIssue = BacklogTask & {
  assigneeId?: number;
  assigneeName: string;
  // The status color set in Backlog, e.g. "#ed8077"
  statusColor?: string;
  // The status is Closed
  closed: boolean;
  // What the chart draws, YYYY-MM-DD. Without a start date the bar starts at
  // the due date; an unfinished issue without a due date runs to today.
  // Missing on undated issues.
  span?: {
    start: string;
    end: string;
    // Whether each end is the issue's own date (false: filled in)
    hasStart: boolean;
    hasEnd: boolean;
  };
};

// GET /backlog/gantt?assigneeIds=1,2&from=&to=&projectKey=&includeClosed=
// Unfinished issues of the people, plus (includeClosed) their Closed issues
// due within the period
export type BacklogGanttResponse = {
  // YYYY-MM-DD in Japan
  today: string;
  from: string;
  to: string;
  // On the chart: the span overlaps the period. In span order.
  issues: BacklogGanttIssue[];
  // Unfinished, with neither a start date nor a due date
  undated: BacklogGanttIssue[];
  // Unfinished, but the span ends before the period (overdue when the
  // period starts today or earlier). Due date order.
  earlier: BacklogGanttIssue[];
  // Unfinished issues starting after the period
  later: number;
  // More issues matched than were read
  truncated: boolean;
};

// ---------- Registering in Backlog (the Backlog page) ----------
// The page drafts with a model, shows every field, and calls these only when
// the user presses the register button.

// A project the user belongs to (GET /backlog/projects)
export type BacklogProjectSummary = {
  id: number;
  projectKey: string;
  name: string;
  // How the project's issue and comment text is written
  textFormattingRule: 'markdown' | 'backlog';
};

export type BacklogNamedItem = {
  id: number;
  name: string;
};

// What a new issue of the project can be set to (GET /backlog/projects/:key)
export type BacklogProjectMeta = {
  project: BacklogProjectSummary;
  issueTypes: BacklogNamedItem[];
  priorities: BacklogNamedItem[];
  // Members of the project
  users: BacklogNamedItem[];
  myself: BacklogNamedItem;
  // A new issue is set to In Progress right after it is created
  // (backlogInProgressOnCreateProjects)
  inProgressOnCreate: boolean;
};

// GET /backlog/issues?projectKey=&keyword=
export type BacklogIssueSummary = {
  issueKey: string;
  summary: string;
  url: string;
  status: string;
  issueType: string;
  // YYYY-MM-DD in Japan
  updated: string;
};

export type BacklogComment = {
  id: number;
  content: string;
  createdUserId?: number;
  createdUserName: string;
  // ISO 8601
  created: string;
  url: string;
};

// An issue as source material for a draft (GET /backlog/issues/:issueKey)
export type BacklogIssueDetail = BacklogIssueSummary & {
  projectKey: string;
  description: string;
  issueTypeId?: number;
  priorityId?: number;
  priority: string;
  textFormattingRule: 'markdown' | 'backlog';
  // The latest comments with text, oldest first
  recentComments: BacklogComment[];
  // The signed-in user's Backlog user ID (to find their own last comment)
  myselfId: number;
};

// POST /backlog/issues
export type BacklogCreateIssueRequest = {
  projectKey: string;
  summary: string;
  description: string;
  issueTypeId: number;
  priorityId: number;
  assigneeId?: number;
  // YYYY-MM-DD
  startDate?: string;
  dueDate?: string;
  // Relate the new issue to this one (e.g. the issue it continues)
  relatedIssueKey?: string;
};

export type BacklogCreateIssueResponse = {
  issueKey: string;
  url: string;
  // The same issue had just been created by the user: it was not created
  // again (e.g. a double click or a retry)
  duplicate: boolean;
  // The status was set to In Progress (inProgressOnCreate)
  inProgress: boolean;
  relatedIssueKey?: string;
  // Steps after the creation that failed; the issue itself exists
  warnings: ('in_progress_failed' | 'relate_failed')[];
};

// POST /backlog/issues/:issueKey/comments
export type BacklogAddCommentRequest = {
  content: string;
};

export type BacklogAddCommentResponse = {
  issueKey: string;
  commentId: number;
  // https://<space>/view/<issueKey>#comment-<id>
  url: string;
  duplicate: boolean;
};

// A folder (parent document) a new document can go under
// (GET /backlog/projects/:projectKey/documents)
export type BacklogDocumentFolder = {
  id: string;
  // e.g. "Meetings / 2026"
  path: string;
};

// POST /backlog/documents
export type BacklogCreateDocumentRequest = {
  projectKey: string;
  title: string;
  // Markdown
  content: string;
  // Put it under this document; the top of the tree when left out
  parentId?: string;
};

export type BacklogCreateDocumentResponse = {
  documentId: string;
  title: string;
  url: string;
  duplicate: boolean;
};
