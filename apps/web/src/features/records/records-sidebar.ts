/** First-screen sidebar lists in weekly Records (T1/M1). */
export const RECORDS_SIDEBAR_PREVIEW_LIMIT = 3;

export function latestWeeklyHighlight<T extends { year: number; week: number }>(
  highlights: readonly T[],
): T | undefined {
  if (highlights.length === 0) return undefined;
  return [...highlights].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  )[0];
}

export function sidebarPreview<T>(
  items: readonly T[],
  expanded: boolean,
  limit = RECORDS_SIDEBAR_PREVIEW_LIMIT,
): { visible: T[]; hiddenCount: number } {
  if (expanded || items.length <= limit) {
    return { visible: [...items], hiddenCount: 0 };
  }
  return {
    visible: items.slice(0, limit) as T[],
    hiddenCount: items.length - limit,
  };
}
