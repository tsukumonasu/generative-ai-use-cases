import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import {
  BacklogErrorResponse,
  BacklogGanttIssue,
  BacklogGanttResponse,
  BacklogMembersResponse,
  BacklogProjectSummary,
} from 'generative-ai-use-cases';
import {
  PiArrowClockwise,
  PiCaretLeft,
  PiCaretRight,
  PiSpinnerGap,
} from 'react-icons/pi';
import Alert from '../Alert';
import SelectCompact from '../SelectCompact';
import Button from '../Button';
import BacklogTaskList from './BacklogTaskList';
import BacklogPeoplePicker from './BacklogPeoplePicker';
import BacklogGanttChart, { BacklogGanttLegend } from './BacklogGanttChart';
import useBacklog from '../../hooks/useBacklog';
import useLocalStorage from '../../hooks/useLocalStorage';
import { backlogErrorMessage } from '../../utils/backlogErrors';
import { backlogToday, formatBacklogDate } from '../../utils/backlogFormat';
import {
  DEFAULT_GANTT_WEEKS,
  GANTT_WEEK_OPTIONS,
  GanttPerson,
  MAX_GANTT_PEOPLE,
  addBacklogDays,
  defaultGanttFrom,
  ganttStepWeeks,
  ganttTo,
  groupByAssignee,
  parseSavedPeople,
} from '../../utils/backlogGantt';

type Props = {
  // Backlog or the vault refused the link: refreshes the link status, which
  // then shows how to link again
  onLinkProblem: () => unknown;
};

// What the chart showed last, remembered per browser. People: JSON of
// { id, name }[]; never saved yet = the user alone.
const PEOPLE_KEY = 'backlogGanttPeople';
const WEEKS_KEY = 'backlogGanttWeeks';
const PROJECT_KEY = 'backlogGanttProject';
const CLOSED_KEY = 'backlogGanttClosed';

const linkReason = (error: unknown) =>
  axios.isAxiosError<BacklogErrorResponse>(error)
    ? error.response?.data?.reason
    : undefined;

// The issues off the chart, per person
const IssuesOffChart: React.FC<{
  label: string;
  issues: BacklogGanttIssue[];
  people: GanttPerson[];
  today: string;
}> = ({ label, issues, people, today }) => {
  const { t } = useTranslation();
  if (issues.length === 0) {
    return null;
  }
  const groups = groupByAssignee(issues, people).filter(
    (group) => group.issues.length > 0
  );
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">{label}</summary>
      <div className="mt-2 flex flex-col gap-3 pl-4">
        {groups.map((group) => (
          <div key={group.person.id}>
            {groups.length > 1 && (
              <div className="text-xs font-semibold">
                {t('backlog.page.gantt.person_heading', {
                  name: group.person.name,
                  n: group.issues.length,
                })}
              </div>
            )}
            <BacklogTaskList tasks={group.issues} today={today} emptyText="" />
          </div>
        ))}
      </div>
    </details>
  );
};

// The gantt chart view of the Backlog page. The user adds the
// people to show one by one; the chart reloads on every change.
const BacklogGanttView: React.FC<Props> = ({ onLinkProblem }) => {
  const { t, i18n } = useTranslation();
  // The page already fetches the link status
  const { listMembers, listProjects, getGantt } = useBacklog(false);
  const today = backlogToday();

  // Kept in a ref: a new function from the page must not reload anything
  const linkProblem = useRef(onLinkProblem);
  linkProblem.current = onLinkProblem;

  const [members, setMembers] = useState<BacklogMembersResponse>();
  const [membersFailed, setMembersFailed] = useState(false);
  const [projects, setProjects] = useState<BacklogProjectSummary[]>();

  const [savedPeople, setSavedPeople] = useLocalStorage(PEOPLE_KEY, '');
  const people = useMemo(() => parseSavedPeople(savedPeople), [savedPeople]);
  const setPeople = useCallback(
    (next: GanttPerson[]) => setSavedPeople(JSON.stringify(next)),
    [setSavedPeople]
  );
  const [savedWeeks, setSavedWeeks] = useLocalStorage(
    WEEKS_KEY,
    String(DEFAULT_GANTT_WEEKS)
  );
  const weeks = GANTT_WEEK_OPTIONS.includes(Number(savedWeeks))
    ? Number(savedWeeks)
    : DEFAULT_GANTT_WEEKS;
  const [projectKey, setProjectKey] = useLocalStorage(PROJECT_KEY, '');
  const [savedClosed, setSavedClosed] = useLocalStorage(CLOSED_KEY, 'false');
  const includeClosed = savedClosed === 'true';
  const [from, setFrom] = useState(() => defaultGanttFrom(today));
  const to = ganttTo(from, weeks);
  const step = ganttStepWeeks(weeks) * 7;

  const [data, setData] = useState<BacklogGanttResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listMembers()
      .then((result) => {
        if (!cancelled) setMembers(result);
      })
      .catch((e) => {
        if (cancelled) return;
        if (linkReason(e)) {
          linkProblem.current();
        }
        console.error('Failed to read the Backlog members:', e);
        setMembersFailed(true);
      });
    listProjects()
      .then((result) => {
        if (!cancelled) setProjects(result);
      })
      // The chart still works over every project
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [listMembers, listProjects]);

  // The first time: the user alone
  useEffect(() => {
    if (savedPeople === '' && members) {
      setPeople([{ id: members.myself.id, name: members.myself.name }]);
    }
  }, [savedPeople, members, setPeople]);

  // A remembered project the user has left (or that was archived)
  useEffect(() => {
    if (
      projectKey &&
      projects &&
      !projects.some((project) => project.projectKey === projectKey)
    ) {
      setProjectKey('');
    }
  }, [projectKey, projects, setProjectKey]);

  // Reload whenever what to show changes. Only the latest request counts.
  const latest = useRef(0);
  useEffect(() => {
    if (people.length === 0) {
      latest.current += 1;
      setData(null);
      setLoading(false);
      return;
    }
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    getGantt({
      assigneeIds: people.map((person) => person.id),
      from,
      to,
      projectKey,
      includeClosed,
    })
      .then((result) => {
        if (request === latest.current) setData(result);
      })
      .catch((e) => {
        if (request !== latest.current) return;
        if (linkReason(e)) {
          linkProblem.current();
          return;
        }
        console.error('Failed to read the Backlog gantt chart:', e);
        setError(backlogErrorMessage(e, t, 'backlog.page.load_failed'));
      })
      .finally(() => {
        if (request === latest.current) setLoading(false);
      });
  }, [people, from, to, projectKey, includeClosed, getGantt, t, reload]);

  // Saved people are shown with their current names
  const shownPeople = useMemo(() => {
    const byId = new Map((members?.members ?? []).map((m) => [m.id, m.name]));
    return people.map((person) => ({
      ...person,
      name: byId.get(person.id) ?? person.name,
    }));
  }, [people, members]);

  const waitingForMyself = savedPeople === '' && !members && !membersFailed;
  // The chart drawn last belongs to these people until the new one arrives
  const chartPeople = data ? shownPeople : [];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="font-semibold">
          {t('backlog.page.gantt.heading', {
            start: formatBacklogDate(from, i18n.language),
            end: formatBacklogDate(to, i18n.language),
          })}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {t('backlog.page.gantt.help', { n: MAX_GANTT_PEOPLE })}
        </p>
      </div>

      <BacklogPeoplePicker
        members={members?.members}
        membersFailed={membersFailed}
        myselfId={members?.myself.id}
        people={shownPeople}
        onAdd={(person) =>
          setPeople([...people, person].slice(0, MAX_GANTT_PEOPLE))
        }
        onRemove={(id) =>
          setPeople(people.filter((person) => person.id !== id))
        }
      />

      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">
            {t('backlog.page.gantt.start')}
          </span>
          <input
            type="date"
            className="rounded border border-black/30 px-2 py-1"
            value={from}
            onChange={(e) => {
              // Cleared with the browser's button: keep the last day
              if (e.target.value) setFrom(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">
            {t('backlog.page.gantt.span')}
          </span>
          <SelectCompact
            label={t('backlog.page.gantt.span')}
            value={String(weeks)}
            onChange={setSavedWeeks}
            options={GANTT_WEEK_OPTIONS.map((option) => ({
              value: String(option),
              label: t('backlog.page.gantt.span_weeks', { n: option }),
            }))}
          />
        </label>
        <div className="flex gap-1">
          <Button
            outlined
            onClick={() => setFrom(addBacklogDays(from, -step))}
            title={t('backlog.page.gantt.prev')}
            aria-label={t('backlog.page.gantt.prev')}>
            <PiCaretLeft className="my-1" />
          </Button>
          <Button outlined onClick={() => setFrom(defaultGanttFrom(today))}>
            {t('backlog.page.gantt.this_week')}
          </Button>
          <Button
            outlined
            onClick={() => setFrom(addBacklogDays(from, step))}
            title={t('backlog.page.gantt.next')}
            aria-label={t('backlog.page.gantt.next')}>
            <PiCaretRight className="my-1" />
          </Button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">
            {t('backlog.page.gantt.project')}
          </span>
          <SelectCompact
            label={t('backlog.page.gantt.project')}
            value={projectKey}
            onChange={setProjectKey}
            options={[
              { value: '', label: t('backlog.page.gantt.project_all') },
              ...(projects ?? []).map((project) => ({
                value: project.projectKey,
                label: t('backlog.page.gantt.project_option', {
                  key: project.projectKey,
                  name: project.name,
                }),
              })),
            ]}
          />
        </label>
        <label className="flex items-center gap-1.5 py-1.5">
          <input
            type="checkbox"
            className="text-aws-smile size-4 rounded border-black/30"
            checked={includeClosed}
            onChange={(e) => setSavedClosed(String(e.target.checked))}
          />
          <span>{t('backlog.page.gantt.closed')}</span>
        </label>
        <Button
          outlined
          onClick={() => setReload((n) => n + 1)}
          disabled={loading || people.length === 0}
          title={t('backlog.page.gantt.reload')}
          aria-label={t('backlog.page.gantt.reload')}>
          <PiArrowClockwise className="my-1" />
        </Button>
      </div>

      {error && (
        <Alert severity="error">
          <span className="text-sm">{error}</span>
        </Alert>
      )}

      {people.length === 0 && !waitingForMyself ? (
        <p className="py-6 text-center text-sm text-gray-500">
          {t('backlog.page.gantt.no_people')}
        </p>
      ) : !data ? (
        (loading || waitingForMyself) && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
            <PiSpinnerGap className="animate-spin text-xl" />
            {t('backlog.page.loading')}
          </div>
        )
      ) : (
        <div className={`flex flex-col gap-3 ${loading ? 'opacity-50' : ''}`}>
          {loading && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <PiSpinnerGap className="animate-spin" />
              {t('backlog.page.loading')}
            </div>
          )}
          <BacklogGanttChart
            data={data}
            people={chartPeople}
            myselfId={members?.myself.id}
          />
          {data.issues.length === 0 && (
            <p className="text-sm text-gray-500">
              {t('backlog.page.gantt.empty')}
            </p>
          )}
          <BacklogGanttLegend />
          {data.truncated && (
            <p className="text-xs text-amber-600">
              {t('backlog.page.gantt.truncated')}
            </p>
          )}
          <IssuesOffChart
            label={t('backlog.page.gantt.earlier', { n: data.earlier.length })}
            issues={data.earlier}
            people={chartPeople}
            today={data.today}
          />
          <IssuesOffChart
            label={t('backlog.page.gantt.undated', { n: data.undated.length })}
            issues={data.undated}
            people={chartPeople}
            today={data.today}
          />
          {data.later > 0 && (
            <p className="text-xs text-gray-500">
              {t('backlog.page.gantt.later', { n: data.later })}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default BacklogGanttView;
