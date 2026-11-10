import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PiSpinnerGap } from 'react-icons/pi';
import { toast } from 'sonner';
import Alert from './Alert';
import Button from './Button';
import useIntegrationLink, {
  IntegrationKind,
  IntegrationState,
  takeReturnPath,
} from '../hooks/useIntegrationLink';

type Props = {
  kind: IntegrationKind;
  integration: IntegrationState & {
    // Binds the finished consent to the signed-in user; resolves to whether
    // the account is now linked
    complete: (sessionUri: string) => Promise<boolean>;
  };
  // Where to go when the link was not started from a page of this tab (e.g.
  // the consent was opened from another tab): the page that uses the link
  defaultNext: string;
};

// The page AgentCore Identity sends the browser to after the consent of a
// per-user integration (e.g. Google Workspace), with
// ?session_id=<session URI>. Completing it binds the consent to the signed-in
// Cognito user (the API rejects it for anyone other than the user who
// started it). Once linked, the user is taken straight back to the page the
// link was started from, the same for every integration.
const IntegrationCallback: React.FC<Props> = ({
  kind,
  integration,
  defaultNext,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [failed, setFailed] = useState(false);
  // Read once: the stored path is forgotten as it is read
  const [next] = useState(() => takeReturnPath(kind) ?? defaultNext);
  const { linking, startLink } = useIntegrationLink(kind, integration);
  const { complete } = integration;
  // A session URI can be bound only once, and StrictMode runs effects twice
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    const sessionUri = searchParams.get('session_id');
    if (!sessionUri) {
      setFailed(true);
      return;
    }
    complete(sessionUri)
      .then((linked) => {
        if (!linked) {
          setFailed(true);
          return;
        }
        toast.success(t(`${kind}.callback_linked`));
        navigate(next, { replace: true });
      })
      .catch((error) => {
        console.error(`Failed to complete ${kind} linking:`, error);
        setFailed(true);
      });
  }, [complete, searchParams, kind, next, navigate, t]);

  const onRetry = async () => {
    if ((await startLink(next)) === 'linked') {
      navigate(next, { replace: true });
    }
  };

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col items-center justify-center gap-4 px-4">
      <div className="text-lg font-semibold">{t(`${kind}.callback_title`)}</div>
      {!failed && (
        <div className="flex items-center gap-2 text-gray-600">
          <PiSpinnerGap className="animate-spin text-xl" />
          {t(`${kind}.callback_completing`)}
        </div>
      )}
      {failed && (
        <>
          <Alert severity="error" className="w-full max-w-md">
            <span className="text-sm">{t(`${kind}.callback_failed`)}</span>
          </Alert>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={onRetry} loading={linking}>
              {t('integration.retry')}
            </Button>
            <Link to={next} replace className="text-aws-smile underline">
              {t('integration.back')}
            </Link>
          </div>
        </>
      )}
    </div>
  );
};

export default IntegrationCallback;
