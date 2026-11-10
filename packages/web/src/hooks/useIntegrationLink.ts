import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

// The per-user account links (e.g. Google Workspace) work the same way
// everywhere. Every page that needs one offers the link button
// itself, and after the consent the callback page brings the user back to the
// page the link was started from (see components/IntegrationCallback.tsx).

export type IntegrationKind = 'google_workspace' | 'backlog';

// The part of useGoogleWorkspace the link flow needs
export type IntegrationState = {
  enabled: boolean;
  allowed: boolean;
  linked: boolean;
  // A token is stored but the service rejects it
  expired?: boolean;
  statusError: boolean;
  isLoading: boolean;
  authorize: (force: boolean) => Promise<string | null>;
  mutate: () => Promise<unknown>;
};

// The consent leaves the app and comes back in the same tab, so the page to
// return to survives in sessionStorage
const returnPathKey = (kind: IntegrationKind) =>
  `integrationReturnPath:${kind}`;

// Only paths inside this app (no //host, no scheme) are followed
const isAppPath = (path: string | null): path is string =>
  !!path && path.startsWith('/') && !path.startsWith('//');

const rememberReturnPath = (kind: IntegrationKind, path: string) => {
  try {
    sessionStorage.setItem(returnPathKey(kind), path);
  } catch {
    // Without storage the callback page falls back to its default page
  }
};

// Reads and forgets the page the link was started from
export const takeReturnPath = (kind: IntegrationKind): string | null => {
  try {
    const path = sessionStorage.getItem(returnPathKey(kind));
    sessionStorage.removeItem(returnPathKey(kind));
    return isAppPath(path) ? path : null;
  } catch {
    return null;
  }
};

const useIntegrationLink = (
  kind: IntegrationKind,
  integration: IntegrationState
) => {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const [linking, setLinking] = useState(false);
  const { authorize, mutate, linked, expired } = integration;

  // Opens the consent. A stored token (linked, or rejected by the service) is
  // replaced by a fresh consent, e.g. to switch accounts or grant new scopes.
  // returnPath: where to come back to; the current page by default.
  // Resolves to 'linked' when the account turned out to be linked already
  // (nothing to consent to), 'failed' when the consent could not be started.
  const startLink = useCallback(
    async (
      returnPath?: string
    ): Promise<'redirected' | 'linked' | 'failed'> => {
      setLinking(true);
      try {
        const authorizationUrl = await authorize(linked || !!expired);
        if (authorizationUrl) {
          rememberReturnPath(kind, returnPath ?? `${pathname}${search}`);
          window.location.assign(authorizationUrl);
          return 'redirected';
        }
        await mutate();
        setLinking(false);
        return 'linked';
      } catch (error) {
        console.error(`Failed to start ${kind} linking:`, error);
        toast.error(t(`${kind}.link_failed`));
        setLinking(false);
        return 'failed';
      }
    },
    [authorize, mutate, linked, expired, kind, pathname, search, t]
  );

  return { linking, startLink };
};

export default useIntegrationLink;
