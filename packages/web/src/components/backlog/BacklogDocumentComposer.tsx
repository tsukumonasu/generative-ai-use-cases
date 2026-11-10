import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BacklogAddCommentResponse,
  BacklogCreateDocumentResponse,
  BacklogDocumentFolder,
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
import useBacklogDraftWords from '../../hooks/useBacklogDraftWords';
import useChatApi from '../../hooks/useChatApi';
import {
  BacklogDocumentKind,
  draftBacklogDocument,
} from '../../prompts/backlogDraft';
import { backlogToday } from '../../utils/backlogFormat';
import { backlogErrorMessage } from '../../utils/backlogErrors';
import {
  BacklogSources,
  MATERIAL_LABELS,
  toMaterial,
} from '../../utils/backlogSource';
import BacklogSourceInput from './BacklogSourceInput';
import { BacklogBodyEditor, BacklogDraftActions } from './BacklogComposeParts';
import useBacklogDraftModel from '../../hooks/useBacklogDraftModel';

// Draft a Backlog document (meeting minutes, or knowledge from a
// conversation or a log) with a model, show it in full, and add it only when
// the user presses the register button. Optionally a comment with its link is
// posted to a related issue in the same click. Backlog has no API to update a
// document, so a document is only ever added.

const PROJECT_STORAGE_KEY = 'backlogProjectKey';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
// The Select treats '' as nothing selected, so the top level has a value
const TOP_LEVEL = '__top__';

type Props = {
  kind: BacklogDocumentKind;
};

const readStoredProject = (): string => {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

const BacklogDocumentComposer: React.FC<Props> = ({ kind }) => {
  const { t } = useTranslation();
  const backlog = useBacklog(false);
  const { predictStream } = useChatApi();
  const {
    modelId: draftModelId,
    setModelId: setDraftModelId,
    model: draftModel,
  } = useBacklogDraftModel();
  const words = useBacklogDraftWords();

  const [projects, setProjects] = useState<BacklogProjectSummary[]>([]);
  const [projectKey, setProjectKey] = useState(readStoredProject);
  const [folders, setFolders] = useState<BacklogDocumentFolder[]>([]);
  const [parentId, setParentId] = useState(TOP_LEVEL);
  const [request, setRequest] = useState('');
  const [sources, setSources] = useState<BacklogSources>({});
  const [busy, setBusy] = useState<'draft' | 'register' | null>(null);

  const [title, setTitle] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [notes, setNotes] = useState('');
  const [linkIssueKey, setLinkIssueKey] = useState('');
  const [linkComment, setLinkComment] = useState('');
  const [result, setResult] = useState<BacklogCreateDocumentResponse | null>(
    null
  );
  const [linked, setLinked] = useState<BacklogAddCommentResponse | null>(null);
  const [error, setError] = useState('');

  const { listProjects, listDocumentFolders } = backlog;
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

  useEffect(() => {
    if (!projectKey) return;
    setFolders([]);
    setParentId(TOP_LEVEL);
    listDocumentFolders(projectKey)
      .then(setFolders)
      .catch((e) => setError(backlogErrorMessage(e, t)));
  }, [projectKey, listDocumentFolders, t]);

  const project = projects.find((p) => p.projectKey === projectKey);

  const draft = useCallback(async () => {
    const model = draftModel;
    if (!model || !project) return;
    setBusy('draft');
    setResult(null);
    setLinked(null);
    setError('');
    try {
      const d = await draftBacklogDocument(predictStream, model, {
        words,
        kind,
        project: { key: project.projectKey, name: project.name },
        today: backlogToday(),
        request: request.trim(),
        material: toMaterial(sources, MATERIAL_LABELS),
      });
      setTitle(d.title);
      setContent(d.content);
      setNotes(d.notes);
      setLinkComment(
        t('backlog.compose.document_link_comment_default', { title: d.title })
      );
    } catch (e) {
      console.error('Failed to draft a Backlog document:', e);
      toast.error(t('backlog.compose.draft_failed'));
    } finally {
      setBusy(null);
    }
  }, [predictStream, draftModel, words, kind, project, request, sources, t]);

  const linkKey = linkIssueKey.trim().toUpperCase();
  const canRegister =
    title !== null &&
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    !!project &&
    busy === null &&
    !result &&
    (!linkKey || ISSUE_KEY.test(linkKey));

  // The only place that adds the document (and the link comment): the user's
  // click. The comment is posted after the document exists, with its URL.
  const register = useCallback(async () => {
    if (!project || title === null) return;
    setBusy('register');
    setError('');
    try {
      const doc = await backlog.createDocument({
        projectKey: project.projectKey,
        title: title.trim(),
        content,
        parentId: parentId === TOP_LEVEL ? undefined : parentId,
      });
      setResult(doc);
      if (linkKey) {
        try {
          setLinked(
            await backlog.addComment(
              linkKey,
              `${linkComment.trim()}\n${doc.url}`
            )
          );
        } catch (e) {
          setError(
            `${t('backlog.compose.document_link_failed', { key: linkKey })} ${backlogErrorMessage(e, t)}`
          );
        }
      }
    } catch (e) {
      setError(backlogErrorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }, [project, title, content, parentId, linkKey, linkComment, backlog, t]);

  const locked = busy !== null || !!result;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500">
        {kind === 'minutes'
          ? t('backlog.compose.minutes_help')
          : t('backlog.compose.knowledge_help')}
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Select
          label={t('backlog.compose.project')}
          value={projectKey}
          options={projects.map((p) => ({
            value: p.projectKey,
            label: `${p.projectKey} ${p.name}`,
          }))}
          onChange={(v) => {
            setProjectKey(v);
            setTitle(null);
            setResult(null);
          }}
          fullWidth
        />
        <Select
          label={t('backlog.compose.document_parent')}
          value={parentId}
          options={[
            {
              value: TOP_LEVEL,
              label: t('backlog.compose.document_parent_top'),
            },
            ...folders.map((f) => ({ value: f.id, label: f.path })),
          ]}
          onChange={setParentId}
          fullWidth
        />
      </div>

      <Textarea
        label={t('backlog.compose.document_request_label')}
        placeholder={
          kind === 'minutes'
            ? t('backlog.compose.minutes_request_placeholder')
            : t('backlog.compose.knowledge_request_placeholder')
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
        <Button
          onClick={draft}
          loading={busy === 'draft'}
          disabled={
            busy !== null ||
            !!result ||
            !project ||
            (!request.trim() && !sources.chat && !sources.file)
          }>
          <PiMagicWand className="mr-1" />
          {title === null
            ? t('backlog.compose.draft')
            : t('backlog.compose.redraft')}
        </Button>
      </BacklogDraftActions>

      {title !== null && project && (
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
            label={t('backlog.compose.document_title')}
            value={title}
            onChange={setTitle}
          />
          <BacklogBodyEditor
            label={t('backlog.compose.document_content')}
            value={content}
            onChange={setContent}
            format="markdown"
            disabled={locked}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <InputText
              label={t('backlog.compose.document_link_issue')}
              placeholder={t('backlog.compose.related_issue_placeholder')}
              value={linkIssueKey}
              onChange={(v) => setLinkIssueKey(v.trim())}
            />
            {linkKey && (
              <div className="md:col-span-2">
                <Textarea
                  label={t('backlog.compose.document_link_comment')}
                  value={linkComment}
                  onChange={setLinkComment}
                  rows={2}
                  disabled={locked}
                />
                <p className="-mt-2 text-xs text-gray-500">
                  {t('backlog.compose.document_link_comment_help')}
                </p>
              </div>
            )}
          </div>
          {!result && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={register}
                loading={busy === 'register'}
                disabled={!canRegister}>
                {t('backlog.compose.register_issue')}
              </Button>
              <span className="text-xs text-gray-500">
                {linkKey
                  ? t('backlog.compose.register_document_and_link_help', {
                      project: project.projectKey,
                      key: linkKey,
                    })
                  : t('backlog.compose.register_document_help', {
                      project: project.projectKey,
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
                ? t('backlog.compose.document_duplicate')
                : t('backlog.compose.document_added')}
            </span>
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-aws-smile flex items-center gap-1 break-all underline">
              {result.title}
              <PiArrowSquareOut className="shrink-0" />
            </a>
            {linked && (
              <a
                href={linked.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-aws-smile flex items-center gap-1 break-all underline">
                {t('backlog.compose.document_linked', { key: linked.issueKey })}
                <PiArrowSquareOut className="shrink-0" />
              </a>
            )}
            <p className="text-xs text-gray-500">
              {t('backlog.compose.document_update_note')}
            </p>
          </div>
        </Alert>
      )}
    </div>
  );
};

export default BacklogDocumentComposer;
