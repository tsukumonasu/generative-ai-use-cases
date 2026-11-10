import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BacklogGanttIssue,
  BacklogGanttResponse,
} from 'generative-ai-use-cases';
import { formatBacklogDate } from '../../utils/backlogFormat';
import {
  GanttPerson,
  backlogDaysBetween,
  ganttBarPosition,
  ganttDayWidth,
  ganttDays,
  ganttMonths,
  groupByAssignee,
} from '../../utils/backlogGantt';

type Props = {
  data: BacklogGanttResponse;
  // In the order they were added; each gets a section, issues or not
  people: GanttPerson[];
  myselfId?: number;
};

// A status without a color in Backlog
const FALLBACK_COLOR = '#6b7280';
const OVERDUE_COLOR = '#dc2626';

const issueTitle = (
  issue: BacklogGanttIssue,
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string
): string => {
  const date = (value?: string) =>
    value ? formatBacklogDate(value, language) : t('backlog.page.gantt.none');
  return [
    `${issue.issueKey} ${issue.summary}`,
    t('backlog.page.gantt.title_status', {
      status: issue.status,
      assignee: issue.assigneeName,
    }),
    t('backlog.page.gantt.title_dates', {
      start: date(issue.startDate),
      due: date(issue.dueDate),
    }),
  ].join('\n');
};

// One issue on its row: a bar from the start date to the due date, or a
// diamond on the due date when there is no start date
const GanttBar: React.FC<{
  issue: BacklogGanttIssue;
  from: string;
  to: string;
  today: string;
  dayWidth: number;
}> = ({ issue, from, to, today, dayWidth }) => {
  const { t, i18n } = useTranslation();
  const span = issue.span;
  const position = span ? ganttBarPosition(span, from, to) : null;
  if (!span || !position) {
    return null;
  }
  const color = issue.statusColor ?? FALLBACK_COLOR;
  const overdue = !issue.closed && !!issue.dueDate && issue.dueDate < today;
  const title = issueTitle(issue, t, i18n.language);
  const left = position.offset * dayWidth;

  if (!span.hasStart && span.start === span.end) {
    return (
      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={title}
        className="absolute top-1/2 size-3 -translate-y-1/2 rotate-45 hover:brightness-110"
        style={{
          left: left + dayWidth / 2 - 6,
          backgroundColor: color,
          opacity: issue.closed ? 0.45 : 1,
          outline: overdue ? `2px solid ${OVERDUE_COLOR}` : undefined,
        }}
      />
    );
  }

  const width = Math.max(position.length * dayWidth - 2, 4);
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={title}
      className={`absolute top-1.5 flex h-5 items-center overflow-hidden rounded hover:brightness-110 ${
        position.clippedStart ? 'rounded-l-none' : ''
      } ${position.clippedEnd ? 'rounded-r-none' : ''}`}
      style={{
        left: left + 1,
        width,
        // No due date: fades out to the right, as it has no end yet
        background: span.hasEnd
          ? color
          : `linear-gradient(to right, ${color} 60%, ${color}33)`,
        opacity: issue.closed ? 0.45 : 1,
        boxShadow: overdue ? `inset 0 0 0 2px ${OVERDUE_COLOR}` : undefined,
      }}>
      {width >= 80 && (
        <span className="truncate px-1.5 text-[11px] text-white">
          {issue.summary}
        </span>
      )}
    </a>
  );
};

// The gantt chart of the Backlog page. The issue column stays on
// the left while the timeline scrolls sideways; one section per person.
const BacklogGanttChart: React.FC<Props> = ({ data, people, myselfId }) => {
  const { t, i18n } = useTranslation();
  const days = useMemo(
    () => ganttDays(data.from, data.to),
    [data.from, data.to]
  );
  const months = useMemo(() => ganttMonths(days), [days]);
  const groups = useMemo(
    () => groupByAssignee(data.issues, people),
    [data.issues, people]
  );
  const dayWidth = ganttDayWidth(days.length);
  const todayIndex =
    data.today >= data.from && data.today <= data.to
      ? backlogDaysBetween(data.from, data.today)
      : -1;
  const monthFormat = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  // Every day is numbered when it is wide enough; otherwise only Mondays
  const everyDay = dayWidth >= 20;

  const personName = (person: GanttPerson) =>
    person.id === myselfId
      ? t('backlog.page.gantt.person_myself', { name: person.name })
      : person.name;

  return (
    <div className="flex overflow-x-auto rounded border bg-white">
      <div className="sticky left-0 z-20 w-40 shrink-0 border-r bg-white md:w-72">
        <div className="flex h-12 items-end border-b px-2 pb-1 text-xs text-gray-500">
          {t('backlog.page.gantt.issue')}
        </div>
        {groups.map((group) => (
          <React.Fragment key={group.person.id}>
            <div className="flex h-8 items-center border-b bg-gray-50 px-2 text-sm font-semibold">
              <span className="truncate">
                {t('backlog.page.gantt.person_heading', {
                  name: personName(group.person),
                  n: group.issues.length,
                })}
              </span>
            </div>
            {group.issues.map((issue) => (
              <div
                key={issue.issueKey}
                className="flex h-8 items-center gap-2 border-b px-2 text-xs"
                title={issueTitle(issue, t, i18n.language)}>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-aws-smile shrink-0 underline">
                  {issue.issueKey}
                </a>
                <span className="truncate">{issue.summary}</span>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>

      <div
        className="relative shrink-0"
        style={{ width: days.length * dayWidth }}>
        <div className="relative h-6 border-b">
          {months.map((month) => (
            <div
              key={month.date}
              className="absolute top-0 h-full truncate border-l px-1 text-xs leading-6 text-gray-600"
              style={{
                left: month.offset * dayWidth,
                width: month.days * dayWidth,
              }}>
              {monthFormat.format(new Date(`${month.date}T00:00:00Z`))}
            </div>
          ))}
        </div>
        <div className="relative h-6 border-b">
          {days.map((day, index) =>
            everyDay || day.weekday === 1 ? (
              <div
                key={day.date}
                className={`absolute top-0 h-full overflow-hidden text-[11px] leading-6 ${
                  everyDay ? 'text-center' : 'border-l pl-0.5'
                } ${
                  index === todayIndex
                    ? 'font-bold text-red-600'
                    : day.weekday === 0
                      ? 'text-red-500'
                      : day.weekday === 6
                        ? 'text-blue-500'
                        : 'text-gray-600'
                }`}
                style={{
                  left: index * dayWidth,
                  // A week's label, cut at the end of the period
                  width: everyDay
                    ? dayWidth
                    : dayWidth * Math.min(7, days.length - index),
                }}>
                {day.day}
              </div>
            ) : null
          )}
        </div>

        {/* Weekends and today, behind the rows */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-12">
          {days.map((day, index) =>
            day.weekday === 0 || day.weekday === 6 ? (
              <div
                key={day.date}
                className="absolute inset-y-0 bg-gray-100"
                style={{ left: index * dayWidth, width: dayWidth }}
              />
            ) : null
          )}
          {todayIndex >= 0 && (
            <div
              className="absolute inset-y-0 z-10 w-0.5 bg-red-500"
              style={{ left: todayIndex * dayWidth + dayWidth / 2 - 1 }}
            />
          )}
        </div>

        {groups.map((group) => (
          <React.Fragment key={group.person.id}>
            <div className="relative h-8 border-b bg-gray-50" />
            {group.issues.map((issue) => (
              <div key={issue.issueKey} className="relative h-8 border-b">
                <GanttBar
                  issue={issue}
                  from={data.from}
                  to={data.to}
                  today={data.today}
                  dayWidth={dayWidth}
                />
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

// What the marks of the chart mean
export const BacklogGanttLegend: React.FC = () => {
  const { t } = useTranslation();
  const bar = 'inline-block h-3 w-6 rounded-sm';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
      <span>{t('backlog.page.gantt.legend_status')}</span>
      <span className="flex items-center gap-1">
        <span className="inline-block size-2.5 rotate-45 bg-gray-500" />
        {t('backlog.page.gantt.legend_due_only')}
      </span>
      <span className="flex items-center gap-1">
        <span
          className={bar}
          style={{
            background: `linear-gradient(to right, ${FALLBACK_COLOR} 60%, ${FALLBACK_COLOR}33)`,
          }}
        />
        {t('backlog.page.gantt.legend_no_due')}
      </span>
      <span className="flex items-center gap-1">
        <span
          className={bar}
          style={{
            backgroundColor: FALLBACK_COLOR,
            boxShadow: `inset 0 0 0 2px ${OVERDUE_COLOR}`,
          }}
        />
        {t('backlog.page.gantt.legend_overdue')}
      </span>
      <span className="flex items-center gap-1">
        <span
          className={bar}
          style={{ backgroundColor: FALLBACK_COLOR, opacity: 0.45 }}
        />
        {t('backlog.page.gantt.legend_closed')}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-0.5 bg-red-500" />
        {t('backlog.page.gantt.legend_today')}
      </span>
    </div>
  );
};

export default BacklogGanttChart;
