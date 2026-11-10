import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BacklogActivitiesResponse } from 'generative-ai-use-cases';
import { PiMagicWand } from 'react-icons/pi';
import { toast } from 'sonner';
import Button from '../Button';
import ButtonCopy from '../ButtonCopy';
import Textarea from '../Textarea';
import useBacklog from '../../hooks/useBacklog';
import useBacklogDraftWords from '../../hooks/useBacklogDraftWords';
import useChatApi from '../../hooks/useChatApi';
import { draftMeetingReport } from '../../prompts/backlogDraft';
import { backlogDaysBefore } from '../../utils/backlogFormat';
import { BacklogDraftActions } from './BacklogComposeParts';
import useBacklogDraftModel from '../../hooks/useBacklogDraftModel';

// Turn the activity summary into a short report for the weekly
// meeting (done / in progress / next / stalled), to paste into the meeting's
// sheet. Nothing is written to Backlog.

// Issues due within this many days count as "next"
const DUE_SOON_DAYS = 7;

const BacklogMeetingReport: React.FC<{
  activities: BacklogActivitiesResponse;
}> = ({ activities }) => {
  const { t } = useTranslation();
  const { getOpenTasks } = useBacklog(false);
  const { predictStream } = useChatApi();
  const {
    modelId: draftModelId,
    setModelId: setDraftModelId,
    model: draftModel,
  } = useBacklogDraftModel();
  const words = useBacklogDraftWords();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const write = useCallback(async () => {
    const model = draftModel;
    if (!model) return;
    setBusy(true);
    try {
      const open = await getOpenTasks();
      // backlogDaysBefore with a negative count goes forward
      const dueBy = backlogDaysBefore(open.today, -DUE_SOON_DAYS);
      const line = (key: string, summary: string, details: string[]) =>
        `- ${key} ${summary}${details.length ? ` (${details.join(', ')})` : ''}`;
      setReport(
        await draftMeetingReport(predictStream, model, {
          words,
          since: activities.since,
          today: activities.today,
          activities: activities.issues.map((issue) =>
            line(issue.issueKey, issue.summary, [
              ...(issue.created ? ['added'] : []),
              ...(issue.completed ? ['completed'] : []),
              ...(issue.comments.length > 0
                ? [`${issue.comments.length} comments`]
                : []),
              ...(issue.updatedFields.length > 0
                ? [`updated ${issue.updatedFields.join('/')}`]
                : []),
              ...(issue.status ? [`status now: ${issue.status}`] : []),
            ])
          ),
          dueSoon: open.tasks
            .filter((task) => task.dueDate && task.dueDate <= dueBy)
            .map((task) =>
              line(task.issueKey, task.summary, [
                `due ${task.dueDate}`,
                `status ${task.status}`,
              ])
            ),
          stalled: open.tasks
            .filter((task) => task.stalled)
            .map((task) =>
              line(task.issueKey, task.summary, [
                `last updated ${task.updated}`,
              ])
            ),
        })
      );
    } catch (e) {
      console.error('Failed to write the meeting report:', e);
      toast.error(t('backlog.compose.draft_failed'));
    } finally {
      setBusy(false);
    }
  }, [getOpenTasks, predictStream, draftModel, words, activities, t]);

  return (
    <div className="mt-4 flex flex-col gap-2 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <BacklogDraftActions
          modelId={draftModelId}
          onModelChange={setDraftModelId}
          disabled={busy}>
          <Button outlined onClick={write} loading={busy}>
            <PiMagicWand className="mr-1" />
            {t('backlog.page.activities.report')}
          </Button>
        </BacklogDraftActions>
        <span className="text-xs text-gray-500">
          {t('backlog.page.activities.report_help')}
        </span>
      </div>
      {report !== null && (
        <div>
          <div className="flex items-center justify-end gap-1 text-xs text-gray-500">
            {t('backlog.page.activities.copy')}
            <ButtonCopy text={report} />
          </div>
          <Textarea value={report} onChange={setReport} rows={12} />
        </div>
      )}
    </div>
  );
};

export default BacklogMeetingReport;
