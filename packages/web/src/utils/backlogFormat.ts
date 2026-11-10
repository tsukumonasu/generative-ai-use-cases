// Display helpers of the Backlog page (pages/BacklogPage.tsx)

// Backlog dates are days in Japan (YYYY-MM-DD); show them as they are
export const formatBacklogDate = (date: string, language: string): string =>
  new Intl.DateTimeFormat(language, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));

// The day `days` before `date` (YYYY-MM-DD)
export const backlogDaysBefore = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

// Today in Japan, where the Backlog space is (YYYY-MM-DD)
export const backlogToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export type BacklogProjectGroup<T> = {
  projectKey: string;
  projectName: string;
  items: T[];
};

// Items grouped by project, projects in key order, items in their order
export const groupByProject = <
  T extends { projectKey: string; projectName: string },
>(
  items: T[]
): BacklogProjectGroup<T>[] => {
  const groups = new Map<string, BacklogProjectGroup<T>>();
  for (const item of items) {
    const group = groups.get(item.projectKey) ?? {
      projectKey: item.projectKey,
      projectName: item.projectName || item.projectKey,
      items: [],
    };
    group.items.push(item);
    groups.set(item.projectKey, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.projectKey.localeCompare(b.projectKey)
  );
};
