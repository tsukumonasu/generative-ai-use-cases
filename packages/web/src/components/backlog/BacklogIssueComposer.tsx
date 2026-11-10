import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BacklogCreateIssueResponse,
  BacklogIssueDetail,
  BacklogIssueSummary,
  BacklogProjectMeta,
  BacklogProjectSummary,
} from 'generative-ai-use-cases';
import { PiArrowSquareOut, PiMagicWand } from 'react-icons/pi';
import { toast } from 'sonner';
import Alert from '../Alert';
import Button from '../Button';
import InputText from '../InputText';
import Select from '../Select';
import Textarea from '../Textarea';
import useBacklog from '../../hooks/useBacklog';
import useChatApi from '../../hooks/useChatApi';
import { draftBacklogIssue } from '../../prompts/backlogDraft';
import useBacklogDraftWords from '../../hooks/useBacklogDraftWords';
import { backlogToday } from '../../utils/backlogFormat';
import BacklogSourceInput from './BacklogSourceInput';
import {
  BacklogSources,
  MATERIAL_LABELS,
  toMaterial,
} from '../../utils/backlogSource';
import {
  BacklogBodyEditor,
  BacklogDraftActions,
  DateInput,
  FieldLabel,
} from './BacklogComposeParts';
import useBacklogDraftModel from '../../hooks/useBacklogDraftModel';
import { backlogErrorMessage } from '../../utils/backlogErrors';

// Draft a new Backlog issue with a model, show every field, and
// add it only when the user presses the register button.
//   new:  from a request, a past chat and/or a file
//   copy: in the same form as an earlier issue of the same recurring work

const PROJECT_STORAGE_KEY = 'backlogProjectKey';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
// Priority IDs are shared by every project; 3 is the normal one
const NORMAL_PRIORITY_ID = 3;
// Similar issues shown after a draft
const MAX_SIMILAR = 5;
// The Select treats '' as nothing selected, so "unassigned" has a value
const UNASSIGNED = '__none__';

type Form = {
  summary: string;
  description: string;
  issueTypeId: string;
  priorityId: string;
  assigneeId: string;
  startDate: string;
  dueDate: string;
  relatedIssueKey: string;
};

type Props = {
  mode: 'new' | 'copy';
  // Continue an existing issue instead: post a progress comment on it
  onCommentInstead: (issueKey: string, sources: BacklogSources) => void;
};

const readStoredProject = (): string => {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

const BacklogIssueComposer: React.FC<Props> = ({ mode, onCommentInstead }) => {
  const { t } = useTranslation();
  const backlog = useBacklog(false);
  const { predictStream } = useChatApi();
  const {
    modelId: draftModelId,
    setModelId: setDraftModelId,
    model: draftModel,
  } = useBacklogDraftModel();

  const [projects, setProjects] = useState<BacklogProjectSummary[]>([]);
  const [projectKey, setProjectKey] = useState(readStoredProject);
  const [meta, setMeta] = useState<BacklogProjectMeta | null>(null);

  const [templateQuery, setTemplateQuery] = useState('');
  const [templateResults, setTemplateResults] = useState<BacklogIssueSummary[]>(
    []
  );
  const [template, setTemplate] = useState<BacklogIssueDetail | null>(null);

  const [request, setRequest] = useState('');
  const [sources, setSources] = useState<BacklogSources>({});
  const [busy, setBusy] = useState<'draft' | 'search' | 'register' | null>(
    null
  );

  const [form, setForm] = useState<Form | null>(null);
  const [defaulted, setDefaulted] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');
  const [similar, setSimilar] = useState<BacklogIssueSummary[]>([]);
  const [result, setResult] = useState<BacklogCreateIssueResponse | null>(null);
  const [error, setError] = useState('');

  const words = useBacklogDraftWords();

  // The projects the user belongs to
  const { listProjects, getProjectMeta } = backlog;
  useEffect(() => {
    listProjects()
      .then((list) => {
        setProjects(list);
        setProjectKey((current) =>
          list.some((p) => p.projectKey === current)
            ? current
            : (list[0]?.projectKey ?? '')
        );
      })
      .catch((e) => setError(backlogErrorMessage(e, t)));
  }, [listProjects, t]);

  // What a new issue of the project can be set to
  useEffect(() => {
    if (!projectKey) return;
    setMeta(null);
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, projectKey);
    } catch {
      // The project choice is only a convenience
    }
    getProjectMeta(projectKey)
      .then(setMeta)
      .catch((e) => setError(backlogErrorMessage(e, t)));
  }, [projectKey, getProjectMeta, t]);

  const reset = () => {
    setForm(null);
    setResult(null);
    setNotes('');
    setSimilar([]);
    setError('');
  };

  // copy: find the earlier issue by key or by keyword in the project
  const findTemplate = useCallback(async () => {
    const query = templateQuery.trim();
    if (!query) return;
    setBusy('search');
    setError('');
    try {
      if (ISSUE_KEY.test(query)) {
        const issue = await backlog.getIssue(query);
        setTemplate(issue);
        setTemplateResults([]);
        setProjectKey(issue.projectKey);
      } else if (projectKey) {
        setTemplateResults(await backlog.searchIssues(projectKey, query));
      }
    } catch (e) {
      setError(backlogErrorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }, [templateQuery, projectKey, backlog, t]);

  const chooseTemplate = useCallback(
    async (issueKey: string) => {
      setBusy('search');
      try {
        const issue = await backlog.getIssue(issueKey);
        setTemplate(issue);
        setTemplateResults([]);
        setProjectKey(issue.projectKey);
      } catch (e) {
        setError(backlogErrorMessage(e, t));
      } finally {
        setBusy(null);
      }
    },
    [backlog, t]
  );

  const material = () => toMaterial(sources, MATERIAL_LABELS);

  const canDraft =
    !!meta &&
    busy === null &&
    (mode === 'copy'
      ? !!template
      : request.trim().length > 0 || !!sources.chat || !!sources.file);

  const draft = useCallback(async () => {
    if (!meta) return;
    const model = draftModel;
    if (!model) return;
    setBusy('draft');
    reset();
    try {
      const d = await draftBacklogIssue(predictStream, model, {
        words,
        project: {
          key: meta.project.projectKey,
          name: meta.project.name,
          format: meta.project.textFormattingRule,
        },
        issueTypes: meta.issueTypes.map((x) => x.name),
        priorities: meta.priorities.map((x) => x.name),
        members: meta.users.map((x) => x.name),
        today: backlogToday(),
        request: request.trim(),
        material: material(),
        template: template
          ? {
              issueKey: template.issueKey,
              summary: template.summary,
              description: template.description,
              issueType: template.issueType,
              priority: template.priority,
            }
          : undefined,
      });

      // Fields the user did not ask for get these defaults:
      // assignee = the user, start = today, priority = normal, no due date
      const marks = new Set<string>();
      const byName = <T extends { id: number; name: string }>(
        list: T[],
        name: string
      ) => (name ? list.find((x) => x.name === name) : undefined);

      let issueTypeId = byName(meta.issueTypes, d.issueType)?.id;
      if (!issueTypeId) {
        issueTypeId =
          meta.issueTypes.find((x) => x.id === template?.issueTypeId)?.id ??
          meta.issueTypes[0]?.id;
        if (!template) marks.add('issueType');
      }
      let priorityId = byName(meta.priorities, d.priority)?.id;
      if (!priorityId) {
        priorityId =
          meta.priorities.find((x) => x.id === template?.priorityId)?.id ??
          meta.priorities.find((x) => x.id === NORMAL_PRIORITY_ID)?.id ??
          meta.priorities[Math.floor(meta.priorities.length / 2)]?.id;
        if (!template) marks.add('priority');
      }
      let assigneeId = byName(meta.users, d.assignee)?.id;
      if (!assigneeId) {
        assigneeId = meta.myself.id;
        marks.add('assignee');
      }
      marks.add('startDate');
      if (!d.dueDate) marks.add('dueDate');

      setForm({
        summary: d.summary,
        description: d.description,
        issueTypeId: String(issueTypeId ?? ''),
        priorityId: String(priorityId ?? ''),
        assigneeId: String(assigneeId),
        startDate: backlogToday(),
        dueDate: d.dueDate,
        relatedIssueKey: template?.issueKey ?? '',
      });
      setDefaulted(marks);
      setNotes(d.notes);

      // Existing issues on the same subject: continue one of them instead?
      if (mode === 'new' && d.keywords.length > 0) {
        const found = await Promise.all(
          d.keywords
            .slice(0, 2)
            .map((k) =>
              backlog.searchIssues(meta.project.projectKey, k).catch(() => [])
            )
        );
        const unique = new Map<string, BacklogIssueSummary>();
        found.flat().forEach((i) => unique.set(i.issueKey, i));
        setSimilar([...unique.values()].slice(0, MAX_SIMILAR));
      }
    } catch (e) {
      console.error('Failed to draft a Backlog issue:', e);
      toast.error(t('backlog.compose.draft_failed'));
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    meta,
    predictStream,
    draftModel,
    words,
    request,
    sources,
    template,
    mode,
    backlog,
    t,
  ]);

  const update = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDefaulted((marks) => {
      const next = new Set(marks);
      Object.keys(patch).forEach((key) => next.delete(key.replace(/Id$/, '')));
      return next;
    });
  };

  const canRegister =
    !!form &&
    !!meta &&
    busy === null &&
    !result &&
    form.summary.trim().length > 0 &&
    !!form.issueTypeId &&
    !!form.priorityId &&
    (!form.dueDate || !form.startDate || form.dueDate >= form.startDate);

  // The only place that adds an issue: the user's click
  const register = useCallback(async () => {
    if (!form || !meta) return;
    setBusy('register');
    setError('');
    try {
      setResult(
        await backlog.createIssue({
          projectKey: meta.project.projectKey,
          summary: form.summary.trim(),
          description: form.description,
          issueTypeId: Number(form.issueTypeId),
          priorityId: Number(form.priorityId),
          assigneeId:
            form.assigneeId && form.assigneeId !== UNASSIGNED
              ? Number(form.assigneeId)
              : undefined,
          startDate: form.startDate || undefined,
          dueDate: form.dueDate || undefined,
          relatedIssueKey: form.relatedIssueKey.trim() || undefined,
        })
      );
    } catch (e) {
      setError(backlogErrorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }, [form, meta, backlog, t]);

  const locked = busy !== null || !!result;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500">
        {mode === 'copy'
          ? t('backlog.compose.copy_help')
          : t('backlog.compose.new_help')}
      </p>

      <Select
        label={t('backlog.compose.project')}
        value={projectKey}
        options={projects.map((p) => ({
          value: p.projectKey,
          label: `${p.projectKey} ${p.name}`,
        }))}
        onChange={(v) => {
          setProjectKey(v);
          setTemplate(null);
          reset();
        }}
        fullWidth
      />
      {meta?.inProgressOnCreate && (
        <p className="-mt-3 text-xs text-gray-500">
          {t('backlog.compose.in_progress_note')}
        </p>
      )}

      {mode === 'copy' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <div className="grow">
              <InputText
                label={t('backlog.compose.template_label')}
                placeholder={t('backlog.compose.template_placeholder')}
                value={templateQuery}
                onChange={setTemplateQuery}
              />
            </div>
            <Button
              outlined
              onClick={findTemplate}
              loading={busy === 'search'}
              disabled={!templateQuery.trim() || locked}>
              {t('backlog.compose.find')}
            </Button>
          </div>
          {templateResults.length > 0 && (
            <ul className="divide-y rounded border text-sm">
              {templateResults.map((issue) => (
                <li key={issue.issueKey}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left hover:bg-gray-100"
                    onClick={() => chooseTemplate(issue.issueKey)}>
                    <span className="mr-2 text-gray-500">{issue.issueKey}</span>
                    {issue.summary}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {template && (
            <div className="rounded border px-2 py-1 text-sm">
              <a
                href={template.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-aws-smile underline">
                {template.issueKey}
              </a>{' '}
              {template.summary}
            </div>
          )}
        </div>
      )}

      <Textarea
        label={
          mode === 'copy'
            ? t('backlog.compose.copy_request_label')
            : t('backlog.compose.request_label')
        }
        placeholder={
          mode === 'copy'
            ? t('backlog.compose.copy_request_placeholder')
            : t('backlog.compose.request_placeholder')
        }
        value={request}
        onChange={setRequest}
        rows={3}
        disabled={locked}
      />
      <BacklogSourceInput
        value={sources}
        onChange={setSources}
        disabled={locked}
      />

      <BacklogDraftActions
        modelId={draftModelId}
        onModelChange={setDraftModelId}
        disabled={busy !== null}>
        <Button onClick={draft} loading={busy === 'draft'} disabled={!canDraft}>
          <PiMagicWand className="mr-1" />
          {form ? t('backlog.compose.redraft') : t('backlog.compose.draft')}
        </Button>
      </BacklogDraftActions>

      {similar.length > 0 && !result && (
        <Alert severity="info">
          <div className="flex flex-col gap-1 text-sm">
            <span>{t('backlog.compose.similar_help')}</span>
            {similar.map((issue) => (
              <div
                key={issue.issueKey}
                className="flex flex-wrap items-center gap-2">
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-aws-smile underline">
                  {issue.issueKey}
                </a>
                <span className="grow">{issue.summary}</span>
                <span className="text-xs text-gray-500">{issue.status}</span>
                <button
                  type="button"
                  className="text-aws-smile text-xs underline"
                  onClick={() => update({ relatedIssueKey: issue.issueKey })}>
                  {t('backlog.compose.relate_to_this')}
                </button>
                <button
                  type="button"
                  className="text-aws-smile text-xs underline"
                  onClick={() => onCommentInstead(issue.issueKey, sources)}>
                  {t('backlog.compose.comment_instead')}
                </button>
              </div>
            ))}
          </div>
        </Alert>
      )}

      {form && meta && (
        <div className="flex flex-col gap-3 rounded border border-black/20 p-4">
          <div className="font-semibold">{t('backlog.compose.review')}</div>
          {notes && (
            <Alert severity="warning">
              <span className="text-sm">
                {t('backlog.compose.notes', { notes })}
              </span>
            </Alert>
          )}
          <InputText
            label={t('backlog.compose.summary')}
            value={form.summary}
            onChange={(v) => update({ summary: v })}
          />
          <BacklogBodyEditor
            label={t('backlog.compose.description')}
            value={form.description}
            onChange={(v) => update({ description: v })}
            format={meta.project.textFormattingRule}
            disabled={locked}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <FieldLabel
                label={t('backlog.compose.issue_type')}
                defaulted={defaulted.has('issueType')}
              />
              <Select
                value={form.issueTypeId}
                options={meta.issueTypes.map((x) => ({
                  value: String(x.id),
                  label: x.name,
                }))}
                onChange={(v) => update({ issueTypeId: v })}
                fullWidth
              />
            </div>
            <div>
              <FieldLabel
                label={t('backlog.compose.priority')}
                defaulted={defaulted.has('priority')}
              />
              <Select
                value={form.priorityId}
                options={meta.priorities.map((x) => ({
                  value: String(x.id),
                  label: x.name,
                }))}
                onChange={(v) => update({ priorityId: v })}
                fullWidth
              />
            </div>
            <div>
              <FieldLabel
                label={t('backlog.compose.assignee')}
                defaulted={defaulted.has('assignee')}
              />
              <Select
                value={form.assigneeId}
                options={[
                  {
                    value: UNASSIGNED,
                    label: t('backlog.compose.unassigned'),
                  },
                  ...meta.users.map((x) => ({
                    value: String(x.id),
                    label: x.name,
                  })),
                ]}
                onChange={(v) => update({ assigneeId: v })}
                fullWidth
              />
            </div>
            <DateInput
              label={
                <FieldLabel
                  label={t('backlog.compose.start_date')}
                  defaulted={defaulted.has('startDate')}
                />
              }
              value={form.startDate}
              onChange={(v) => update({ startDate: v })}
              disabled={locked}
            />
            <DateInput
              label={
                <FieldLabel
                  label={t('backlog.compose.due_date')}
                  defaulted={defaulted.has('dueDate')}
                />
              }
              value={form.dueDate}
              onChange={(v) => update({ dueDate: v })}
              disabled={locked}
            />
            <InputText
              label={t('backlog.compose.related_issue')}
              placeholder={t('backlog.compose.related_issue_placeholder')}
              value={form.relatedIssueKey}
              onChange={(v) => update({ relatedIssueKey: v.trim() })}
            />
          </div>
          {defaulted.size > 0 && (
            <p className="text-xs text-gray-500">
              {t('backlog.compose.defaults_help')}
            </p>
          )}

          {!result && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={register}
                loading={busy === 'register'}
                disabled={!canRegister}>
                {t('backlog.compose.register_issue')}
              </Button>
              <span className="text-xs text-gray-500">
                {t('backlog.compose.register_help', {
                  project: meta.project.projectKey,
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {error && (
        <Alert severity="error">
          <span className="text-sm">{error}</span>
        </Alert>
      )}

      {result && (
        <Alert severity="info">
          <div className="flex flex-col gap-1 text-sm">
            <span>
              {result.duplicate
                ? t('backlog.compose.issue_duplicate')
                : t('backlog.compose.issue_added')}
            </span>
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-aws-smile flex items-center gap-1 underline">
              {result.issueKey} {result.url}
              <PiArrowSquareOut />
            </a>
            {result.inProgress && (
              <span>{t('backlog.compose.set_in_progress')}</span>
            )}
            {result.relatedIssueKey && (
              <span>
                {t('backlog.compose.related', { key: result.relatedIssueKey })}
              </span>
            )}
            {result.warnings.includes('in_progress_failed') && (
              <span className="text-red-600">
                {t('backlog.compose.in_progress_failed')}
              </span>
            )}
            {result.warnings.includes('relate_failed') && (
              <span className="text-red-600">
                {t('backlog.compose.relate_failed')}
              </span>
            )}
            <div>
              <Button outlined onClick={reset}>
                {t('backlog.compose.another')}
              </Button>
            </div>
          </div>
        </Alert>
      )}
    </div>
  );
};

export default BacklogIssueComposer;
