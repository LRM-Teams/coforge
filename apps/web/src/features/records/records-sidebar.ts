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

export type MemberWeekLanding =
  | { kind: "highlight"; id: string }
  | { kind: "week"; year: number; week: number };

/** Newest member-week target for `/records` weekly landing (ADR 0015). */
export function latestMemberWeekLanding(
  weeks: readonly { year: number; week: number; highlightId: string | null }[],
): MemberWeekLanding | undefined {
  if (weeks.length === 0) return undefined;
  const latest = [...weeks].sort((left, right) =>
    left.year !== right.year ? right.year - left.year : right.week - left.week,
  )[0];
  if (!latest) return undefined;
  if (latest.highlightId) return { kind: "highlight", id: latest.highlightId };
  return { kind: "week", year: latest.year, week: latest.week };
}

/** Prefer member-week landing; fall back to catalog highlights for non-leaders. */
export function latestWeeklyLanding(input: {
  memberWeeks: readonly { year: number; week: number; highlightId: string | null }[];
  highlights: readonly { id: string; year: number; week: number }[];
}): MemberWeekLanding | undefined {
  return (
    latestMemberWeekLanding(input.memberWeeks) ??
    (() => {
      const highlight = latestWeeklyHighlight(input.highlights);
      return highlight ? { kind: "highlight" as const, id: highlight.id } : undefined;
    })()
  );
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
