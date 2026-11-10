import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BacklogActivitiesResponse,
  BacklogIssueActivity,
} from 'generative-ai-use-cases';
import { PiArrowSquareOut } from 'react-icons/pi';
import ButtonCopy from '../ButtonCopy';
import BacklogMeetingReport from './BacklogMeetingReport';
import { formatBacklogDate, groupByProject } from '../../utils/backlogFormat';

// What the user did on Backlog issues in a period (the activity
// summary of the Backlog page), with a plain-text copy for weekly reports

type Props = {
  activities: BacklogActivitiesResponse;
};

const BacklogActivityList: React.FC<Props> = ({ activities }) => {
  const { t, i18n } = useTranslation();
  const groups = useMemo(
    () => groupByProject(activities.issues),
    [activities.issues]
  );

  // e.g. "Updated: Status, Due date"
  const updatedLabel = (issue: BacklogIssueActivity): string =>
    t('backlog.page.activities.updated', {
      fields: issue.updatedFields
        .map((field) =>
          t(`backlog.page.fields.${field}`, { defaultValue: field })
        )
        .join(t('backlog.page.activities.separator')),
    });

  // Labels of one issue's activity, e.g. ["Added", "Comments: 2"]
  const labelsOf = (issue: BacklogIssueActivity): string[] => {
    const labels: string[] = [];
    if (issue.created) labels.push(t('backlog.page.activities.created'));
    if (issue.completed) labels.push(t('backlog.page.activities.completed'));
    if (issue.comments.length > 0) {
      labels.push(
        t('backlog.page.activities.commented', { n: issue.comments.length })
      );
    }
    if (issue.updatedFields.length > 0) {
      labels.push(updatedLabel(issue));
    }
    return labels;
  };

  const period = t('backlog.page.activities.heading', {
    since: formatBacklogDate(activities.since, i18n.language),
    today: formatBacklogDate(activities.today, i18n.language),
  });

  const counts = {
    issues: activities.issues.length,
    created: activities.issues.filter((i) => i.created).length,
    completed: activities.issues.filter((i) => i.completed).length,
    comments: activities.issues.reduce((n, i) => n + i.comments.length, 0),
  };

  // Markdown for a weekly report sheet or a chat
  const copyText = [
    period,
    '',
    ...groups.flatMap((group) => [
      `## ${group.projectName}`,
      ...group.items.map(
        (issue) =>
          `- [${issue.issueKey} ${issue.summary}](${issue.url}) ${labelsOf(
            issue
          ).join(t('backlog.page.activities.separator'))}`
      ),
      '',
    ]),
  ].join('\n');

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">{period}</div>
        {activities.issues.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-gray-500">
            {t('backlog.page.activities.copy')}
            <ButtonCopy text={copyText} />
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {t('backlog.page.activities.help')}
      </p>
      <p className="mt-2 text-sm">
        {t('backlog.page.activities.summary', counts)}
      </p>

      {activities.issues.length === 0 ? (
        <p className="py-2 text-sm text-gray-500">
          {t('backlog.page.activities.empty')}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.projectKey}>
              <div className="text-sm font-semibold">
                {t('backlog.page.project_heading', {
                  name: group.projectName,
                  n: group.items.length,
                })}
              </div>
              <ul className="divide-y">
                {group.items.map((issue) => (
                  <li
                    key={issue.issueKey}
                    className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:gap-3">
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-aws-smile flex shrink-0 items-center gap-1 text-sm underline md:w-28">
                      {issue.issueKey}
                      <PiArrowSquareOut className="shrink-0" />
                    </a>
                    <span className="min-w-0 grow break-words text-sm">
                      {issue.summary}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {issue.created && (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-800">
                          {t('backlog.page.activities.created')}
                        </span>
                      )}
                      {issue.completed && (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-800">
                          {t('backlog.page.activities.completed')}
                        </span>
                      )}
                      {issue.comments.length > 0 && (
                        <a
                          href={issue.comments[issue.comments.length - 1].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700 underline">
                          {t('backlog.page.activities.commented', {
                            n: issue.comments.length,
                          })}
                        </a>
                      )}
                      {issue.updatedFields.length > 0 && (
                        <span className="text-gray-500">
                          {updatedLabel(issue)}
                        </span>
                      )}
                      {issue.status && (
                        <span className="text-gray-500">
                          {t('backlog.page.activities.status_now', {
                            status: issue.status,
                          })}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {activities.truncated && (
        <p className="mt-3 text-xs text-amber-600">
          {t('backlog.page.activities.truncated')}
        </p>
      )}
      <BacklogMeetingReport activities={activities} />
    </div>
  );
};

export default BacklogActivityList;
