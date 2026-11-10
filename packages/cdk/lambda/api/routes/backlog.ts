import { Router, Request, Response } from 'express';
import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  BacklogResult,
  BacklogUser,
  authorize,
  complete,
  findIssues,
  getActivities,
  getDocumentFolders,
  getGantt,
  getIssue,
  getMembers,
  getOpenTasks,
  getProject,
  getProjects,
  getStatus,
  getWeeklyTasks,
  isBacklogConfigured,
  postComment,
  postDocument,
  postIssue,
} from '../../backlog';

// Backlog account linking and the Backlog page (Backlog construct). API
// Gateway only has these routes when backlogEnabled is true.

export const router = Router();

type RequestWithApiGateway = Request & {
  apiGateway?: {
    event?: { requestContext?: APIGatewayProxyEvent['requestContext'] };
  };
};

// The user comes only from the Cognito authorizer claims. Nothing in the
// request body or headers is trusted to say who the user is.
const getUser = (req: Request): BacklogUser | undefined => {
  const claims =
    (req as RequestWithApiGateway).apiGateway?.event?.requestContext?.authorizer
      ?.claims ?? {};
  const value = (key: string) =>
    typeof claims[key] === 'string' ? (claims[key] as string) : undefined;
  const sub = value('sub');
  return sub
    ? { sub, username: value('cognito:username'), email: value('email') }
    : undefined;
};

const route =
  (
    fn: (
      user: BacklogUser,
      origin: string | undefined,
      req: Request
    ) => Promise<BacklogResult<unknown>>
  ) =>
  async (req: Request, res: Response) => {
    // Responses carry the user's Backlog data
    res.setHeader('Cache-Control', 'no-store');
    if (!isBacklogConfigured()) {
      res.status(404).json({ message: 'Backlog is not enabled' });
      return;
    }
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    try {
      const result = await fn(user, req.headers.origin, req);
      res.status(result.statusCode).json(result.body);
    } catch (error) {
      // Name and message only. Never log the error object or the result:
      // they can carry the workload access token or the Backlog token.
      console.error(
        'Backlog error:',
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error
      );
      res.status(500).json({ message: 'Internal server error' });
    }
  };

router.get(
  '/status',
  route((user, origin) => getStatus(user, origin))
);
router.post(
  '/authorize',
  route((user, origin, req) =>
    authorize(user, origin, req.body?.force === true)
  )
);
router.post(
  '/complete',
  route((user, origin, req) => complete(user, origin, req.body?.sessionUri))
);
router.get(
  '/tasks',
  route((user, origin) => getWeeklyTasks(user, origin))
);
router.get(
  '/my-issues',
  route((user, origin) => getOpenTasks(user, origin))
);
router.get(
  '/activities',
  route((user, origin, req) => getActivities(user, origin, req.query.since))
);
// The gantt chart: whom to show, then their issues
router.get(
  '/members',
  route((user, origin) => getMembers(user, origin))
);
router.get(
  '/gantt',
  route((user, origin, req) => getGantt(user, origin, req.query))
);

// Registering in Backlog (the Backlog page, after the user's OK)
router.get(
  '/projects',
  route((user, origin) => getProjects(user, origin))
);
router.get(
  '/projects/:projectKey',
  route((user, origin, req) => getProject(user, origin, req.params.projectKey))
);
router.get(
  '/issues',
  route((user, origin, req) =>
    findIssues(user, origin, req.query.projectKey, req.query.keyword)
  )
);
router.get(
  '/issues/:issueKey',
  route((user, origin, req) => getIssue(user, origin, req.params.issueKey))
);
router.post(
  '/issues',
  route((user, origin, req) => postIssue(user, origin, req.body))
);
router.post(
  '/issues/:issueKey/comments',
  route((user, origin, req) =>
    postComment(user, origin, req.params.issueKey, req.body?.content)
  )
);
router.get(
  '/projects/:projectKey/documents',
  route((user, origin, req) =>
    getDocumentFolders(user, origin, req.params.projectKey)
  )
);
router.post(
  '/documents',
  route((user, origin, req) => postDocument(user, origin, req.body))
);
