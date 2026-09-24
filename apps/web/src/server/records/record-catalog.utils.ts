import type { Prisma } from "#src/generated/prisma/client";
import {
  currentIsoWeek,
  normalizeReportContent,
  type ReportContent,
} from "#src/features/records/records-content";
import type { TemplateOutlineSection } from "#src/features/records/template-outline-sections";

export function asReportContent(value: unknown): ReportContent {
  return normalizeReportContent(value);
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type TemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipientUserIds: string[];
};

/** The columns a template create or update writes from validated input. */
export function templateWriteData(input: TemplateInput, sections: TemplateOutlineSection[]) {
  return {
    name: input.name.trim(),
    frequency: input.frequency,
    sendTime: input.sendTime,
    sendWeekday: input.sendWeekday,
    applied: input.scheduleEnabled,
    scheduleEnabled: input.scheduleEnabled,
    dimensions: sections as unknown as Prisma.InputJsonValue,
    mainTitles: [] as string[],
    allMembers: input.allMembers,
    recipients: input.allMembers
      ? undefined
      : { create: input.recipientUserIds.map((userId) => ({ userId })) },
  };
}

export function isoWeeksTouchingMonth(
  year: number,
  month: number,
): Array<{ year: number; week: number }> {
  const days = new Date(year, month, 0).getDate();
  const seen = new Set<string>();
  const result: Array<{ year: number; week: number }> = [];
  for (let day = 1; day <= days; day += 1) {
    const iso = currentIsoWeek(new Date(year, month - 1, day));
    const key = `${iso.year}-${iso.week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(iso);
  }
  return result;
}
