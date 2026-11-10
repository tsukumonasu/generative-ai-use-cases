// The Backlog page (docs/en/BACKLOG.md). One-click features for
// the user's own Backlog account. The GenU API reads Backlog with the user's
// token from the AgentCore Identity Token Vault; no model is involved, so the
// lists are quick and the same every time.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import {
  BacklogActivitiesResponse,
  BacklogErrorResponse,
  BacklogOpenTasksResponse,
  BacklogWeeklyTasksResponse,
} from 'generative-ai-use-cases';
import {
  PiCalendarCheck,
  PiChartBarHorizontal,
  PiChatText,
  PiClockCounterClockwise,
  PiCopy,
  PiLightbulb,
  PiListChecks,
  PiNotebook,
  PiNotePencil,
  PiSpinnerGap,
} from 'react-icons/pi';
import Alert from '../components/Alert';
import Button from '../components/Button';
import Card from '../components/Card';
import IntegrationNotice from '../components/IntegrationNotice';
import BacklogTaskList, {
  BacklogTaskGroups,
} from '../components/backlog/BacklogTaskList';
import BacklogActivityList from '../components/backlog/BacklogActivityList';
import BacklogIssueComposer from '../components/backlog/BacklogIssueComposer';
import BacklogCommentComposer from '../components/backlog/BacklogCommentComposer';
import BacklogDocumentComposer from '../components/backlog/BacklogDocumentComposer';
import BacklogGanttView from '../components/backlog/BacklogGanttView';
import { BacklogSources } from '../utils/backlogSource';
import useBacklog from '../hooks/useBacklog';
import {
  backlogDaysBefore,
  backlogToday,
  formatBacklogDate,
} from '../utils/backlogFormat';

type ReadView = 'weekly' | 'open' | 'activities' | 'gantt';
// Drafted by a model, registered only by the user's click
type WriteView =
  | 'new_issue'
  | 'copy_issue'
  | 'comment'
  | 'minutes'
  | 'knowledge';
type View = ReadView | WriteView;
const WRITE_VIEWS: WriteView[] = [
  'new_issue',
  'copy_issue',
  'comment',
  'minutes',
  'knowledge',
];

// The activity summary covers the last week unless the user picks a day
const DEFAULT_ACTIVITY_DAYS = 7;
// The API accepts days within this many days
const MAX_ACTIVITY_DAYS = 90;

const BacklogPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const backlog = useBacklog();
  const {
    getWeeklyTasks,
    getOpenTasks,
    getActivities,
    mutate: refreshStatus,
  } = backlog;

  const today = backlogToday();
  const [view, setView] = useState<View>('weekly');
  const [weekly, setWeekly] = useState<BacklogWeeklyTasksResponse | null>(null);
  const [open, setOpen] = useState<BacklogOpenTasksResponse | null>(null);
  const [activities, setActivities] =
    useState<BacklogActivitiesResponse | null>(null);
  const [since, setSince] = useState(
    backlogDaysBefore(today, DEFAULT_ACTIVITY_DAYS)
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The gantt chart keeps its own state: once opened, it stays mounted
  // (hidden) so that switching views keeps the people and the period
  const [ganttOpened, setGanttOpened] = useState(false);
  // Write forms opened so far: they stay mounted (hidden) so that switching
  // to a list and back keeps the draft
  const [openedForms, setOpenedForms] = useState<WriteView[]>([]);
  // A progress comment opened from a similar issue of the issue form
  const [commentStart, setCommentStart] = useState<{
    issueKey: string;
    sources: BacklogSources;
    // Remounts the comment form for a new start
    nonce: number;
  } | null>(null);

  const openForm = useCallback((form: WriteView) => {
    setView(form);
    setOpenedForms((opened) =>
      opened.includes(form) ? opened : [...opened, form]
    );
  }, []);

  // Runs one read. A request Backlog or the vault refused for the link
  // (not linked, or the token was rejected) refreshes the status, which then
  // shows how to link again.
  const load = useCallback(
    async (read: () => Promise<void>) => {
      setLoading(true);
      setFailed(false);
      try {
        await read();
      } catch (error) {
        const reason = axios.isAxiosError<BacklogErrorResponse>(error)
          ? error.response?.data?.reason
          : undefined;
        if (reason) {
          await refreshStatus();
        } else {
          console.error('Failed to read Backlog:', error);
          setFailed(true);
        }
      } finally {
        setLoading(false);
      }
    },
    [refreshStatus]
  );

  const showWeekly = useCallback(() => {
    setView('weekly');
    return load(async () => setWeekly(await getWeeklyTasks()));
  }, [load, getWeeklyTasks]);

  const showOpen = useCallback(() => {
    setView('open');
    return load(async () => setOpen(await getOpenTasks()));
  }, [load, getOpenTasks]);

  const showActivities = useCallback(() => {
    setView('activities');
    return load(async () => setActivities(await getActivities(since)));
  }, [load, getActivities, since]);

  const showGantt = useCallback(() => {
    setView('gantt');
    setGanttOpened(true);
  }, []);

  // Show this week's tasks as soon as the page opens
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (backlog.linked && !autoLoaded.current) {
      autoLoaded.current = true;
      showWeekly();
    }
  }, [backlog.linked, showWeekly]);

  // The link button and its notice are shared with the agent chat and the
  // settings page (components/IntegrationNotice.tsx)
  const linkNotice = (
    <IntegrationNotice
      kind="backlog"
      integration={backlog}
      notLinkedText={t('backlog.page.link_required')}
      notAllowedText={t('backlog.page.not_allowed')}
    />
  );

  const writeButtons: {
    id: WriteView;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      id: 'new_issue',
      label: t('backlog.page.write.new_issue'),
      icon: <PiNotePencil className="mr-1" />,
    },
    {
      id: 'copy_issue',
      label: t('backlog.page.write.copy_issue'),
      icon: <PiCopy className="mr-1" />,
    },
    {
      id: 'comment',
      label: t('backlog.page.write.comment'),
      icon: <PiChatText className="mr-1" />,
    },
    {
      id: 'minutes',
      label: t('backlog.page.write.minutes'),
      icon: <PiNotebook className="mr-1" />,
    },
    {
      id: 'knowledge',
      label: t('backlog.page.write.knowledge'),
      icon: <PiLightbulb className="mr-1" />,
    },
  ];

  const viewButtons: {
    id: ReadView;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
  }[] = [
    {
      id: 'weekly',
      label: t('backlog.page.weekly_tasks.button'),
      icon: <PiCalendarCheck className="mr-1" />,
      onClick: showWeekly,
    },
    {
      id: 'open',
      label: t('backlog.page.open_tasks.button'),
      icon: <PiListChecks className="mr-1" />,
      onClick: showOpen,
    },
    {
      id: 'activities',
      label: t('backlog.page.activities.button'),
      icon: <PiClockCounterClockwise className="mr-1" />,
      onClick: showActivities,
    },
    {
      id: 'gantt',
      label: t('backlog.page.gantt.button'),
      icon: <PiChartBarHorizontal className="mr-1" />,
      onClick: showGantt,
    },
  ];

  const result = (() => {
    if (view === 'weekly' && weekly) {
      return (
        <>
          <div className="font-semibold">
            {t('backlog.page.weekly_tasks.heading', {
              start: formatBacklogDate(weekly.weekStart, i18n.language),
              end: formatBacklogDate(weekly.weekEnd, i18n.language),
            })}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {t('backlog.page.weekly_tasks.help')}
          </p>
          <div className="mt-4 text-sm font-semibold text-red-600">
            {t('backlog.page.weekly_tasks.overdue', {
              n: weekly.overdue.length,
            })}
          </div>
          <BacklogTaskList
            tasks={weekly.overdue}
            today={weekly.today}
            emptyText={t('backlog.page.weekly_tasks.empty_overdue')}
          />
          <div className="mt-4 text-sm font-semibold">
            {t('backlog.page.weekly_tasks.this_week', {
              n: weekly.thisWeek.length,
            })}
          </div>
          <BacklogTaskList
            tasks={weekly.thisWeek}
            today={weekly.today}
            emptyText={t('backlog.page.weekly_tasks.empty_this_week')}
          />
          {weekly.truncated && (
            <p className="mt-3 text-xs text-amber-600">
              {t('backlog.page.truncated', {
                n: weekly.overdue.length + weekly.thisWeek.length,
              })}
            </p>
          )}
        </>
      );
    }
    if (view === 'open' && open) {
      return (
        <>
          <div className="font-semibold">
            {t('backlog.page.open_tasks.heading', { n: open.tasks.length })}
          </div>
          <p className="mb-3 mt-1 text-xs text-gray-500">
            {t('backlog.page.open_tasks.help', { days: open.stalledDays })}
          </p>
          <BacklogTaskGroups
            tasks={open.tasks}
            today={open.today}
            emptyText={t('backlog.page.open_tasks.empty')}
            showStalled
          />
          {open.truncated && (
            <p className="mt-3 text-xs text-amber-600">
              {t('backlog.page.truncated', { n: open.tasks.length })}
            </p>
          )}
        </>
      );
    }
    if (view === 'activities' && activities) {
      return <BacklogActivityList activities={activities} />;
    }
    return null;
  })();

  return (
    <div className="grid grid-cols-12 gap-4 p-4">
      <div className="invisible col-span-12 my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {t('backlog.page.title')}
      </div>

      <div className="col-span-12">
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-gray-600">
                {t('backlog.page.description')}
              </p>
              {backlog.linked && (
                <span className="text-sm text-gray-600">
                  {backlog.userName
                    ? t('backlog.status_linked_as', { name: backlog.userName })
                    : t('backlog.status_linked')}
                </span>
              )}
            </div>
            {linkNotice}
            <div className="flex flex-wrap gap-2">
              {viewButtons.map((button) => (
                <Button
                  key={button.id}
                  outlined={view !== button.id}
                  onClick={button.onClick}
                  disabled={!backlog.linked || loading}>
                  {button.icon}
                  {button.label}
                </Button>
              ))}
            </div>
            <div className="text-xs text-gray-500">
              {t('backlog.page.write.help')}
            </div>
            <div className="flex flex-wrap gap-2">
              {writeButtons.map((button) => (
                <Button
                  key={button.id}
                  outlined={view !== button.id}
                  onClick={() => openForm(button.id)}
                  disabled={!backlog.linked || !backlog.allowed}>
                  {button.icon}
                  {button.label}
                </Button>
              ))}
            </div>
            {view === 'activities' && backlog.linked && (
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">
                    {t('backlog.page.activities.since')}
                  </span>
                  <input
                    type="date"
                    className="rounded border border-black/30 px-2 py-1"
                    value={since}
                    min={backlogDaysBefore(today, MAX_ACTIVITY_DAYS)}
                    max={today}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </label>
                <Button
                  outlined
                  onClick={showActivities}
                  disabled={loading || !since}>
                  {t('backlog.page.activities.show')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>

      {backlog.linked &&
        WRITE_VIEWS.filter((form) => openedForms.includes(form)).map((form) => (
          <div
            key={form}
            className={`col-span-12 ${view === form ? '' : 'hidden'}`}>
            <Card label={t(`backlog.page.write.${form}`)}>
              {form === 'comment' && (
                <BacklogCommentComposer
                  key={commentStart?.nonce ?? 0}
                  initialIssueKey={commentStart?.issueKey}
                  initialSources={commentStart?.sources}
                />
              )}
              {(form === 'minutes' || form === 'knowledge') && (
                <BacklogDocumentComposer kind={form} />
              )}
              {(form === 'new_issue' || form === 'copy_issue') && (
                <BacklogIssueComposer
                  mode={form === 'copy_issue' ? 'copy' : 'new'}
                  onCommentInstead={(issueKey, sources) => {
                    setCommentStart({ issueKey, sources, nonce: Date.now() });
                    openForm('comment');
                  }}
                />
              )}
            </Card>
          </div>
        ))}

      {backlog.linked && ganttOpened && (
        <div className={`col-span-12 ${view === 'gantt' ? '' : 'hidden'}`}>
          <Card>
            <BacklogGanttView onLinkProblem={refreshStatus} />
          </Card>
        </div>
      )}

      {backlog.linked &&
        view !== 'gantt' &&
        !WRITE_VIEWS.includes(view as WriteView) && (
          <div className="col-span-12">
            <Card>
              {failed && (
                <Alert severity="error" className="mb-3">
                  <span className="text-sm">
                    {t('backlog.page.load_failed')}
                  </span>
                </Alert>
              )}
              {loading && !result ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
                  <PiSpinnerGap className="animate-spin text-xl" />
                  {t('backlog.page.loading')}
                </div>
              ) : (
                <div className={loading ? 'opacity-50' : ''}>{result}</div>
              )}
            </Card>
          </div>
        )}
    </div>
  );
};

export default BacklogPage;
