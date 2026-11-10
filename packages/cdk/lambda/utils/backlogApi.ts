// Calls to the Backlog API with a user's own access token
// (lambda/backlog.ts). Requests go only to the space host set by the
// Backlog construct (BACKLOG_SPACE_DOMAIN), never to a host from a request.

const REQUEST_TIMEOUT_MS = 10_000;

export class BacklogApiError extends Error {
  constructor(
    public readonly status: number,
    path: string
  ) {
    super(`Backlog returned ${status} for ${path}`);
    this.name = 'BacklogApiError';
  }
}

/** Whether Backlog refused the token itself (revoked or not refreshed). */
export const isRejectedToken = (error: unknown): boolean =>
  error instanceof BacklogApiError &&
  (error.status === 401 || error.status === 403);

export const backlogSpaceDomain = (): string => {
  const domain = process.env.BACKLOG_SPACE_DOMAIN;
  if (!domain) {
    throw new Error('BACKLOG_SPACE_DOMAIN is not set');
  }
  return domain;
};

// Personal settings > Apps: the authorized apps, where users remove GenU's
// access on the Backlog side (Backlog has no API to revoke a token)
export const backlogApplicationsUrl = (): string =>
  `https://${backlogSpaceDomain()}/EditApplications.action`;

export const backlogIssueUrl = (issueKey: string): string =>
  `https://${backlogSpaceDomain()}/view/${encodeURIComponent(issueKey)}`;

export const backlogCommentUrl = (issueKey: string, commentId: number) =>
  `${backlogIssueUrl(issueKey)}#comment-${commentId}`;

export const backlogDocumentUrl = (projectKey: string, documentId: string) =>
  `https://${backlogSpaceDomain()}/document/${encodeURIComponent(projectKey)}/${encodeURIComponent(documentId)}`;

export type BacklogQuery = Record<
  string,
  string | number | (string | number)[] | undefined
>;

const appendQuery = (params: URLSearchParams, query: BacklogQuery) => {
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(`${name}[]`, String(item));
      }
    } else {
      params.set(name, String(value));
    }
  }
};

const request = async <T>(
  accessToken: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  query: BacklogQuery
): Promise<T> => {
  const url = new URL(`https://${backlogSpaceDomain()}/api/v2${path}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  let body: string | undefined;
  if (method === 'GET') {
    appendQuery(url.searchParams, query);
  } else {
    // Backlog takes form parameters for writes
    const form = new URLSearchParams();
    appendQuery(form, query);
    body = form.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url.toString(), {
    ...(method === 'GET' ? {} : { method, body }),
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new BacklogApiError(res.status, path);
  }
  return (await res.json()) as T;
};

/**
 * GET a Backlog API v2 path (e.g. "/issues") as the token's user. Array
 * values become repeated "name[]" parameters, as Backlog expects.
 */
export const backlogGet = <T>(
  accessToken: string,
  path: string,
  query: BacklogQuery = {}
): Promise<T> => request<T>(accessToken, 'GET', path, query);

/** POST form parameters to a Backlog API v2 path as the token's user. */
export const backlogPost = <T>(
  accessToken: string,
  path: string,
  form: BacklogQuery
): Promise<T> => request<T>(accessToken, 'POST', path, form);

/** PATCH form parameters to a Backlog API v2 path as the token's user. */
export const backlogPatch = <T>(
  accessToken: string,
  path: string,
  form: BacklogQuery
): Promise<T> => request<T>(accessToken, 'PATCH', path, form);
