import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BacklogDraftWords } from '../prompts/backlogDraft';

// The language and section headings of Backlog drafts. They are
// in the locale files (backlog.draft.*) because the headings are written in
// the user's language, and web code cannot hold Japanese text.
const useBacklogDraftWords = (): BacklogDraftWords => {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      language: t('backlog.draft.language'),
      issueSections: t('backlog.draft.issue_sections').split('|'),
      commentSections: t('backlog.draft.comment_sections').split('|'),
      minutesSections: t('backlog.draft.minutes_sections').split('|'),
      knowledgeSections: t('backlog.draft.knowledge_sections').split('|'),
      reportSections: t('backlog.draft.report_sections').split('|'),
    }),
    [t]
  );
};

export default useBacklogDraftWords;
