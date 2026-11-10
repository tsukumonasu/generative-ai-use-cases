import React from 'react';
import { useTranslation } from 'react-i18next';
import { BacklogTask } from 'generative-ai-use-cases';
import { PiArrowSquareOut } from 'react-icons/pi';
import { formatBacklogDate, groupByProject } from '../../utils/backlogFormat';

type Props = {
  tasks: BacklogTask[];
  // YYYY-MM-DD in Japan: due dates before it are shown as overdue
  today: string;
  emptyText: string;
  // Mark the issues not updated for a while
  showStalled?: boolean;
  // Hide the project of each row (the list is already one project)
  hideProject?: boolean;
};

// Issues of the Backlog page, one row each
const BacklogTaskList: React.FC<Props> = ({
  tasks,
  today,
  emptyText,
  showStalled,
  hideProject,
}) => {
  const { t, i18n } = useTranslation();
  if (tasks.length === 0) {
    return <p className="py-2 text-sm text-gray-500">{emptyText}</p>;
  }
  return (
    <ul className="divide-y">
      {tasks.map((task) => (
        <li
          key={task.issueKey}
          className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:gap-3">
          <a
            href={task.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-aws-smile flex shrink-0 items-center gap-1 text-sm underline md:w-28">
            {task.issueKey}
            <PiArrowSquareOut className="shrink-0" />
          </a>
          <span className="min-w-0 grow break-words text-sm">
            {task.summary}
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            {showStalled && task.stalled && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                {t('backlog.page.task.stalled')}
              </span>
            )}
            {!hideProject && <span>{task.projectName || task.projectKey}</span>}
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">
              {task.status}
            </span>
            {task.priority && (
              <span>
                {t('backlog.page.task.priority', { name: task.priority })}
              </span>
            )}
            {task.dueDate ? (
              <span
                className={
                  task.dueDate < today
                    ? 'font-semibold text-red-600'
                    : 'text-gray-700'
                }>
                {t('backlog.page.task.due', {
                  date: formatBacklogDate(task.dueDate, i18n.language),
                })}
              </span>
            ) : (
              <span>{t('backlog.page.task.no_due')}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
};

// The same list split by project
export const BacklogTaskGroups: React.FC<Omit<Props, 'hideProject'>> = (
  props
) => {
  const { t } = useTranslation();
  if (props.tasks.length === 0) {
    return <BacklogTaskList {...props} />;
  }
  return (
    <div className="flex flex-col gap-4">
      {groupByProject(props.tasks).map((group) => (
        <div key={group.projectKey}>
          <div className="text-sm font-semibold">
            {t('backlog.page.project_heading', {
              name: group.projectName,
              n: group.items.length,
            })}
          </div>
          <BacklogTaskList {...props} tasks={group.items} hideProject />
        </div>
      ))}
    </div>
  );
};

export default BacklogTaskList;
