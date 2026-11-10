// Messages for failed /backlog requests (the Backlog page)
import axios from 'axios';
import { BacklogErrorResponse } from 'generative-ai-use-cases';

// The message to show for a failed /backlog request
export const backlogErrorMessage = (
  error: unknown,
  t: (key: string) => string,
  // Shown when nothing more specific is known
  fallbackKey: string = 'backlog.compose.failed'
): string => {
  if (axios.isAxiosError<BacklogErrorResponse>(error)) {
    const data = error.response?.data;
    if (data?.reason === 'expired' || data?.reason === 'not_linked') {
      return t('backlog.status_expired');
    }
    if (error.response?.status === 404) {
      return t('backlog.compose.not_found');
    }
    if (error.response?.status === 403) {
      return t('backlog.compose.forbidden');
    }
    if (data?.message) {
      return `${t(fallbackKey)} (${data.message})`;
    }
  }
  return t(fallbackKey);
};
