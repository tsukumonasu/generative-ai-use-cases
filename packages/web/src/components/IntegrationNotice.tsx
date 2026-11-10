import React from 'react';
import { useTranslation } from 'react-i18next';
import { PiSpinnerGap } from 'react-icons/pi';
import Alert from './Alert';
import Button from './Button';
import useIntegrationLink, {
  IntegrationKind,
  IntegrationState,
} from '../hooks/useIntegrationLink';

type Props = {
  kind: IntegrationKind;
  integration: IntegrationState;
  // Why this page needs the link
  notLinkedText: string;
  // Shown when the user may not link the account; nothing when omitted
  notAllowedText?: string;
  className?: string;
};

// The same notice wherever a page needs a per-user account link (e.g.
// Google Workspace): why it is needed and the link button itself,
// so nobody has to go to the settings page first. After the consent the user
// comes back to this page (hooks/useIntegrationLink.ts). Renders nothing once
// the account is linked.
const IntegrationNotice: React.FC<Props> = ({
  kind,
  integration,
  notLinkedText,
  notAllowedText,
  className,
}) => {
  const { t } = useTranslation();
  const { linking, startLink } = useIntegrationLink(kind, integration);

  if (!integration.enabled || integration.linked) {
    return null;
  }
  if (integration.isLoading) {
    return (
      <div
        className={`flex items-center gap-2 text-sm text-gray-500 ${className ?? ''}`}>
        <PiSpinnerGap className="animate-spin" />
        {t('integration.checking')}
      </div>
    );
  }
  if (integration.statusError) {
    return (
      <Alert severity="error" className={className}>
        <span className="text-sm">{t(`${kind}.status_error`)}</span>
      </Alert>
    );
  }
  if (!integration.allowed) {
    return notAllowedText ? (
      <Alert severity="info" className={className}>
        <span className="text-sm">{notAllowedText}</span>
      </Alert>
    ) : null;
  }
  return (
    <Alert
      severity={integration.expired ? 'warning' : 'info'}
      className={className}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">
          {integration.expired ? t(`${kind}.status_expired`) : notLinkedText}
        </span>
        <Button onClick={() => startLink()} loading={linking}>
          {integration.expired ? t(`${kind}.relink`) : t(`${kind}.link`)}
        </Button>
      </div>
    </Alert>
  );
};

export default IntegrationNotice;
