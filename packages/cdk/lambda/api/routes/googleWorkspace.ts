import { Router, Request, Response } from 'express';
import { APIGatewayProxyEvent } from 'aws-lambda';
import {
  GoogleWorkspaceResult,
  GoogleWorkspaceUser,
  authorize,
  complete,
  getAccessToken,
  getStatus,
  isGoogleWorkspaceConfigured,
} from '../../googleWorkspace';

// Google Workspace MCP account linking (GoogleWorkspace construct).
// API Gateway only has these routes when googleWorkspaceMcpEnabled is true.

export const router = Router();

type RequestWithApiGateway = Request & {
  apiGateway?: {
    event?: { requestContext?: APIGatewayProxyEvent['requestContext'] };
  };
};

// The user comes only from the Cognito authorizer claims. Nothing in the
// request body or headers is trusted to say who the user is.
const getUser = (req: Request): GoogleWorkspaceUser | undefined => {
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
      user: GoogleWorkspaceUser,
      origin: string | undefined,
      req: Request
    ) => Promise<GoogleWorkspaceResult<unknown>>
  ) =>
  async (req: Request, res: Response) => {
    // Responses may carry a Google access token
    res.setHeader('Cache-Control', 'no-store');
    if (!isGoogleWorkspaceConfigured()) {
      res.status(404).json({ message: 'Google Workspace is not enabled' });
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
      // Name and message only (enough to tell e.g. AccessDenied from a return
      // URL that is not allowed). Never log the error object or the result:
      // they can carry the workload access token or the Google token.
      console.error(
        'Google Workspace error:',
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
router.post(
  '/token',
  route((user, origin) => getAccessToken(user, origin))
);
