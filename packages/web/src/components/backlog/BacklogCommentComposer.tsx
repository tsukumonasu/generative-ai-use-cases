import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BacklogAddCommentResponse,
  BacklogIssueDetail,
} from 'generative-ai-use-cases';
import { PiArrowSquareOut, PiMagicWand } from 'react-icons/pi';
import { toast } from 'sonner';
import Alert from '../Alert';
import Button from '../Button';
import InputText from '../InputText';
import Switch from '../Switch';
import Textarea from '../Textarea';
import useBacklog from '../../hooks/useBacklog';
import useChatApi from '../../hooks/useChatApi';
import { draftBacklogComment } from '../../prompts/backlogDraft';
import useBacklogDraftWords from '../../hooks/useBacklogDraftWords';
import BacklogSourceInput from './BacklogSourceInput';
import {
  BacklogSources,
  MATERIAL_LABELS,
  toMaterial,
} from '../../utils/backlogSource';
import { BacklogBodyEditor, BacklogDraftActions } from './BacklogComposeParts';
import useBacklogDraftModel from '../../hooks/useBacklogDraftModel';
import { backlogErrorMessage } from '../../utils/backlogErrors';

// Draft a progress comment for a Backlog issue from a past chat
// or a Claude Code log (only what happened after the user's last comment),
// show it in full, and post it only when the user presses the button. The
// comment changes nothing else on the issue.

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

type Props = {
  // Opened from a similar issue of the issue form
  initialIssueKey?: string;
  initialSources?: BacklogSources;
};

const BacklogCommentComposer: React.FC<Props> = ({
  initialIssueKey,
  initialSources,
}) => {
  const { t, i18n } = useTranslation();
  const backlog = useBacklog(false);
  const { predictStream } = useChatApi();
  const {
    modelId: draftModelId,
    setModelId: setDraftModelId,
    model: draftModel,
  } = useBacklogDraftModel();
  const words = useBacklogDraftWords();

  const [issueKey, setIssueKey] = useState(initialIssueKey ?? '');
  const [issue, setIssue] = useState<BacklogIssueDetail | null>(null);
  const [sources, setSources] = useState<BacklogSources>(initialSources ?? {});
  const [onlySinceLast, setOnlySinceLast] = useState(true);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState<'load' | 'draft' | 'post' | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<BacklogAddCommentResponse | null>(null);
  const [error, setError] = useState('');

  // The user's own last comment: the previous progress report
  const lastOwnComment = useMemo(
    () =>
      issue?.recentComments
        .filter((c) => c.createdUserId === issue.myselfId)
        .slice(-1)[0],
    [issue]
  );

  const { getIssue } = backlog;
  const load = useCallback(
    async (key: string) => {
      const normalized = key.trim().toUpperCase();
      if (!ISSUE_KEY.test(normalized)) {
        setError(t('backlog.compose.issue_key_invalid'));
        return;
      }
      setBusy('load');
      setError('');
      setIssue(null);
      setContent(null);
      setResult(null);
      try {
        setIssue(await getIssue(normalized));
      } catch (e) {
        setError(backlogErrorMessage(e, t));
      } finally {
        setBusy(null);
      }
    },
    [getIssue, t]
  );

  useEffect(() => {
    if (initialIssueKey) {
      load(initialIssueKey);
    }
  }, [initialIssueKey, load]);

  const logSince =
    onlySinceLast && lastOwnComment ? lastOwnComment.created : undefined;

  const draft = useCallback(async () => {
    if (!issue) return;
    const model = draftModel;
    if (!model) return;
    setBusy('draft');
    setResult(null);
    setError('');
    try {
      const d = await draftBacklogComment(predictStream, model, {
        words,
        format: issue.textFormattingRule,
        issue: {
          key: issue.issueKey,
          summary: issue.summary,
          description: issue.description,
        },
        previousComment: lastOwnComment
          ? { created: lastOwnComment.created, content: lastOwnComment.content }
          : undefined,
        request: request.trim(),
        material: toMaterial(sources, MATERIAL_LABELS, logSince),
      });
      setContent(d.content);
      setNotes(d.notes);
    } catch (e) {
      console.error('Failed to draft a Backlog comment:', e);
      toast.error(t('backlog.compose.draft_failed'));
    } finally {
      setBusy(null);
    }
  }, [
    issue,
    predictStream,
    draftModel,
    words,
    t,
    lastOwnComment,
    request,
    sources,
    logSince,
  ]);

  // The only place that posts a comment: the user's click
  const post = useCallback(async () => {
    if (!issue || !content?.trim()) return;
    setBusy('post');
    setError('');
    try {
      setResult(await backlog.addComment(issue.issueKey, content));
    } catch (e) {
      setError(backlogErrorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }, [issue, content, backlog, t]);

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      timeZone: 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));

  const locked = busy !== null || !!result;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500">
        {t('backlog.compose.comment_help')}
      </p>

      <div className="flex items-end gap-2">
        <div className="grow">
          <InputText
            label={t('backlog.compose.issue_key')}
            placeholder={t('backlog.compose.issue_key_placeholder')}
            value={issueKey}
            onChange={setIssueKey}
          />
        </div>
        <Button
          outlined
          onClick={() => load(issueKey)}
          loading={busy === 'load'}
          disabled={!issueKey.trim() || locked}>
          {t('backlog.compose.load_issue')}
        </Button>
      </div>

      {issue && (
        <div className="rounded border px-3 py-2 text-sm">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-aws-smile underline">
            {issue.issueKey}
          </a>{' '}
          {issue.summary}
          <div className="mt-1 text-xs text-gray-500">
            {lastOwnComment ? (
              <>
                {t('backlog.compose.last_comment', {
                  time: formatTime(lastOwnComment.created),
                })}{' '}
                <a
                  href={lastOwnComment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline">
                  {t('backlog.compose.open')}
                </a>
              </>
            ) : (
              t('backlog.compose.no_last_comment')
            )}
          </div>
        </div>
      )}

      {issue && (
        <>
          <BacklogSourceInput
            value={sources}
            onChange={setSources}
            logSince={logSince}
            disabled={locked}
          />
          {lastOwnComment && sources.file?.isLog && (
            <Switch
              checked={onlySinceLast}
              onSwitch={setOnlySinceLast}
              label={t('backlog.compose.only_since_last', {
                time: formatTime(lastOwnComment.created),
              })}
            />
          )}
          <Textarea
            label={t('backlog.compose.comment_request_label')}
            placeholder={t('backlog.compose.comment_request_placeholder')}
            value={request}
            onChange={setRequest}
            rows={2}
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
                (!sources.chat && !sources.file && !request.trim())
              }>
              <PiMagicWand className="mr-1" />
              {content === null
                ? t('backlog.compose.draft')
                : t('backlog.compose.redraft')}
            </Button>
          </BacklogDraftActions>
        </>
      )}

      {issue && content !== null && (
        <div className="flex flex-col gap-3 rounded border border-black/20 p-4">
          <div className="font-semibold">{t('backlog.compose.review')}</div>
          {notes && (
            <Alert severity="warning">
              <span className="text-sm">
                {t('backlog.compose.notes', { notes })}
              </span>
            </Alert>
          )}
          <BacklogBodyEditor
            label={t('backlog.compose.comment')}
            value={content}
            onChange={setContent}
            format={issue.textFormattingRule}
            disabled={locked}
          />
          {!result && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={post}
                loading={busy === 'post'}
                disabled={busy !== null || !content.trim()}>
                {t('backlog.compose.post_comment')}
              </Button>
              <span className="text-xs text-gray-500">
                {t('backlog.compose.post_help', { key: issue.issueKey })}
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
                ? t('backlog.compose.comment_duplicate')
                : t('backlog.compose.comment_added')}
            </span>
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-aws-smile flex items-center gap-1 break-all underline">
              {result.url}
              <PiArrowSquareOut className="shrink-0" />
            </a>
          </div>
        </Alert>
      )}
    </div>
  );
};

export default BacklogCommentComposer;
