/** First-screen sidebar lists in weekly Records (T1/M1). */
export const RECORDS_SIDEBAR_PREVIEW_LIMIT = 3;

export type WeeklyLanding = { kind: "report"; id: string };

/** Newest member-week report target for `/records` weekly landing. */
export function latestWeeklyLanding(input: {
  memberWeeks: readonly {
    year: number;
    week: number;
    overviewReportId: string;
    submissions: readonly { id: string }[];
  }[];
}): WeeklyLanding | undefined {
  if (input.memberWeeks.length === 0) return undefined;
  const latest = [...input.memberWeeks].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  )[0];
  if (!latest) return undefined;
  return { kind: "report", id: latest.submissions[0]?.id ?? latest.overviewReportId };
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
