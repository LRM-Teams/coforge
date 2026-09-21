/** Collect plan time windows (ADR 0032 period-brief window semantics). */

export type CollectWindowKind = "week" | "month" | "quarter" | "year" | "custom";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCollectCustomRange(startDate: string, endDate: string): boolean {
  const start = startDate.trim();
  const end = endDate.trim();
  if (!YMD.test(start) || !YMD.test(end)) return false;
  return start <= end;
}

export function formatCollectDayLabel(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

export function formatCollectWindowLabel(windowStart: Date, windowEndExclusive: Date): string {
  const endInclusive = new Date(windowEndExclusive.getTime() - 86_400_000);
  return `${formatCollectDayLabel(windowStart)} - ${formatCollectDayLabel(endInclusive)}`;
}

function utcYmd(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

/** Monday 00:00 UTC of the ISO week. */
export function isoWeekMonday(year: number, week: number): Date {
  const jan4 = utcYmd(year, 0, 4);
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (day - 1) + (week - 1) * 7);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export function resolveCollectWindow(input: {
  kind: CollectWindowKind;
  year?: number;
  week?: number;
  month?: number;
  quarter?: number;
  customStart?: string;
  customEnd?: string;
  now?: Date;
}): { windowStart: Date; windowEnd: Date; label: string } {
  const now = input.now ?? new Date();
  if (input.kind === "custom") {
    const start = (input.customStart ?? "").trim();
    const end = (input.customEnd ?? "").trim();
    if (!isValidCollectCustomRange(start, end)) {
      throw new Error("invalid custom range");
    }
    const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
    const [ey, em, ed] = end.split("-").map(Number) as [number, number, number];
    const windowStart = utcYmd(sy, sm - 1, sd);
    const windowEnd = utcYmd(ey, em - 1, ed + 1);
    return {
      windowStart,
      windowEnd,
      label: formatCollectWindowLabel(windowStart, windowEnd),
    };
  }

  if (input.kind === "week") {
    const year = input.year ?? now.getUTCFullYear();
    const week = input.week ?? 1;
    const windowStart = isoWeekMonday(year, week);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowStart.getUTCDate() + 7);
    return {
      windowStart,
      windowEnd,
      label: formatCollectWindowLabel(windowStart, windowEnd),
    };
  }

  if (input.kind === "month") {
    const year = input.year ?? now.getUTCFullYear();
    const month = input.month ?? now.getUTCMonth() + 1;
    const windowStart = utcYmd(year, month - 1, 1);
    const windowEnd = utcYmd(year, month, 1);
    return {
      windowStart,
      windowEnd,
      label: formatCollectWindowLabel(windowStart, windowEnd),
    };
  }

  if (input.kind === "quarter") {
    const year = input.year ?? now.getUTCFullYear();
    const quarter = input.quarter ?? Math.floor(now.getUTCMonth() / 3) + 1;
    const startMonth = (quarter - 1) * 3;
    const windowStart = utcYmd(year, startMonth, 1);
    const windowEnd = utcYmd(year, startMonth + 3, 1);
    return {
      windowStart,
      windowEnd,
      label: formatCollectWindowLabel(windowStart, windowEnd),
    };
  }

  const year = input.year ?? now.getUTCFullYear();
  const windowStart = utcYmd(year, 0, 1);
  const windowEnd = utcYmd(year + 1, 0, 1);
  return {
    windowStart,
    windowEnd,
    label: formatCollectWindowLabel(windowStart, windowEnd),
  };
}

export function defaultCustomRangeEndingToday(now = new Date()): {
  startDate: string;
  endDate: string;
} {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 6);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export function listCollectWindowOptions(
  kind: CollectWindowKind,
  now = new Date(),
): Array<{
  id: string;
  label: string;
  year?: number;
  week?: number;
  month?: number;
  quarter?: number;
}> {
  if (kind === "week") {
    const options: Array<{
      id: string;
      label: string;
      year: number;
      week: number;
    }> = [];
    // Current ISO week and a few prior.
    const { year, week } = (() => {
      const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dayNum = utc.getUTCDay() || 7;
      utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
      const w = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return { year: utc.getUTCFullYear(), week: w };
    })();
    for (let i = 0; i < 8; i += 1) {
      let y = year;
      let w = week - i;
      while (w < 1) {
        y -= 1;
        w += 52;
      }
      const range = resolveCollectWindow({ kind: "week", year: y, week: w });
      options.push({
        id: `${y}-W${w}`,
        label: range.label,
        year: y,
        week: w,
      });
    }
    return options;
  }
  if (kind === "month") {
    const options = [];
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const range = resolveCollectWindow({ kind: "month", year, month });
      options.push({ id: `${year}-${month}`, label: range.label, year, month });
    }
    return options;
  }
  if (kind === "quarter") {
    const options = [];
    const currentQ = Math.floor(now.getUTCMonth() / 3) + 1;
    let year = now.getUTCFullYear();
    let quarter = currentQ;
    for (let i = 0; i < 8; i += 1) {
      const range = resolveCollectWindow({ kind: "quarter", year, quarter });
      options.push({ id: `${year}-Q${quarter}`, label: range.label, year, quarter });
      quarter -= 1;
      if (quarter < 1) {
        quarter = 4;
        year -= 1;
      }
    }
    return options;
  }
  if (kind === "year") {
    const options = [];
    for (let i = 0; i < 5; i += 1) {
      const year = now.getUTCFullYear() - i;
      const range = resolveCollectWindow({ kind: "year", year });
      options.push({ id: String(year), label: range.label, year });
    }
    return options;
  }
  return [];
}
