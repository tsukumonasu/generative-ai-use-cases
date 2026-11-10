import { useCallback } from 'react';
import {
  BacklogAuthorizeRequest,
  BacklogAuthorizeResponse,
  BacklogCompleteRequest,
  BacklogCompleteResponse,
  BacklogStatusResponse,
  BacklogActivitiesResponse,
  BacklogAddCommentRequest,
  BacklogAddCommentResponse,
  BacklogCreateDocumentRequest,
  BacklogCreateDocumentResponse,
  BacklogCreateIssueRequest,
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
import useHttp from './useHttp';

// The Backlog page. Each user links their own Backlog account; the tokens
// stay in the AgentCore Identity Token Vault on the server side.
export const backlogEnabled: boolean =
  import.meta.env.VITE_APP_BACKLOG_ENABLED === 'true';

export const BACKLOG_CALLBACK_PATHNAME = '/backlog/callback';

// The Backlog page (pages/BacklogPage.tsx)
export const BACKLOG_PATHNAME = '/backlog';

// fetchStatus: set false where the link status is not needed (e.g. the
// callback page, which completes the link itself), so the status API is not
// called needlessly
const useBacklog = (fetchStatus: boolean = true) => {
  const http = useHttp();
  // Do not call the API at all when the feature is not deployed
  const { data, error, isLoading, mutate } = http.get<BacklogStatusResponse>(
    backlogEnabled && fetchStatus ? '/backlog/status' : null
  );

  // Start Backlog consent. Resolves to the consent URL to open, or null when
  // the account is already linked (and force is not set).
  const authorize = useCallback(
    async (force: boolean): Promise<string | null> => {
      const res = await http.post<
        BacklogAuthorizeResponse,
        BacklogAuthorizeRequest
      >('/backlog/authorize', { force });
      return res.data.linked ? null : res.data.authorizationUrl;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const complete = useCallback(
    async (sessionUri: string): Promise<boolean> => {
      const res = await http.post<
        BacklogCompleteResponse,
        BacklogCompleteRequest
      >('/backlog/complete', { sessionUri });
      await mutate();
      return res.data.linked;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate]
  );

  // The user's unfinished issues due by the end of this week. Backlog is read
  // on the server with the user's token; the token never reaches the browser.
  const getWeeklyTasks =
    useCallback(async (): Promise<BacklogWeeklyTasksResponse> => {
      const res =
        await http.api.get<BacklogWeeklyTasksResponse>('/backlog/tasks');
      return res.data;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

  const getOpenTasks =
    useCallback(async (): Promise<BacklogOpenTasksResponse> => {
      const res =
        await http.api.get<BacklogOpenTasksResponse>('/backlog/my-issues');
      return res.data;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

  // since: YYYY-MM-DD in Japan
  const getActivities = useCallback(
    async (since: string): Promise<BacklogActivitiesResponse> => {
      const res = await http.api.get<BacklogActivitiesResponse>(
        '/backlog/activities',
        { params: { since } }
      );
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ---------- Gantt chart ----------

  // The members of the user's projects: whom the chart can show
  const listMembers = useCallback(async (): Promise<BacklogMembersResponse> => {
    const res = await http.api.get<BacklogMembersResponse>('/backlog/members');
    return res.data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // from / to: YYYY-MM-DD in Japan, both included
  const getGantt = useCallback(
    async (req: {
      assigneeIds: number[];
      from: string;
      to: string;
      projectKey?: string;
      includeClosed: boolean;
    }): Promise<BacklogGanttResponse> => {
      const res = await http.api.get<BacklogGanttResponse>('/backlog/gantt', {
        params: {
          // One parameter: axios would send an array as assigneeIds[]
          assigneeIds: req.assigneeIds.join(','),
          from: req.from,
          to: req.to,
          projectKey: req.projectKey || undefined,
          includeClosed: req.includeClosed ? 'true' : undefined,
        },
      });
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ---------- Registering (drafted on the Backlog page) ----------

  const listProjects = useCallback(async () => {
    const res =
      await http.api.get<BacklogProjectSummary[]>('/backlog/projects');
    return res.data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getProjectMeta = useCallback(
    async (projectKey: string) => {
      const res = await http.api.get<BacklogProjectMeta>(
        `/backlog/projects/${encodeURIComponent(projectKey)}`
      );
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const searchIssues = useCallback(
    async (projectKey: string, keyword: string) => {
      const res = await http.api.get<BacklogIssueSummary[]>('/backlog/issues', {
        params: { projectKey, keyword },
      });
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const getIssue = useCallback(
    async (issueKey: string) => {
      const res = await http.api.get<BacklogIssueDetail>(
        `/backlog/issues/${encodeURIComponent(issueKey)}`
      );
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Writes. Call these only from the user's click on a register button.
  const createIssue = useCallback(
    async (req: BacklogCreateIssueRequest) => {
      const res = await http.post<
        BacklogCreateIssueResponse,
        BacklogCreateIssueRequest
      >('/backlog/issues', req);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const listDocumentFolders = useCallback(
    async (projectKey: string) => {
      const res = await http.api.get<BacklogDocumentFolder[]>(
        `/backlog/projects/${encodeURIComponent(projectKey)}/documents`
      );
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const createDocument = useCallback(
    async (req: BacklogCreateDocumentRequest) => {
      const res = await http.post<
        BacklogCreateDocumentResponse,
        BacklogCreateDocumentRequest
      >('/backlog/documents', req);
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const addComment = useCallback(
    async (issueKey: string, content: string) => {
      const res = await http.post<
        BacklogAddCommentResponse,
        BacklogAddCommentRequest
      >(`/backlog/issues/${encodeURIComponent(issueKey)}/comments`, {
        content,
      });
      return res.data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return {
    enabled: backlogEnabled,
    allowed: data?.allowed ?? false,
    linked: data?.linked ?? false,
    // A token is stored but Backlog rejects it: the user has to link again
    expired: data?.expired ?? false,
    userName: data?.userName,
    // Where the user unlinks GenU on the Backlog side, when linked
    applicationsUrl: data?.applicationsUrl,
    // e.g. the credential provider or IAM is misconfigured after a deploy
    statusError: !!error,
    isLoading,
    mutate,
    authorize,
    complete,
    getWeeklyTasks,
    getOpenTasks,
    getActivities,
    listMembers,
    getGantt,
    listProjects,
    getProjectMeta,
    searchIssues,
    getIssue,
    createIssue,
    addComment,
    listDocumentFolders,
    createDocument,
  };
};

export default useBacklog;
