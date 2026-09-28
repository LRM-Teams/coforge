import {
  WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
  zonedCalendarDate,
  zonedWeekdayAndTime,
} from "./weekly-report-schedule-due";
import { isoWeekMonday } from "./weekly-report-collect-window";

/** Shanghai has no DST; civil time is UTC+8. */
const SHANGHAI_OFFSET_HOURS = 8;

export function currentWeekTemplateTitle(year: number, week: number): string {
  return `${year} W${week} 模板`;
}

/** Sidebar chip copy. Multiple applied streams append the settings name so they stay distinct. */
export function formatChipLabel(input: {
  year: number;
  week: number;
  settingsName?: string | null;
  distinguishSettingsName?: boolean;
}): string {
  const weekTitle = currentWeekTemplateTitle(input.year, input.week);
  const settingsName = input.settingsName?.trim() ?? "";
  if (input.distinguishSettingsName && settingsName.length > 0 && settingsName !== weekTitle) {
    return `${weekTitle} · ${settingsName}`;
  }
  return weekTitle;
}

export function splitWeeklyTemplateRoles<T extends { hasAssignments: boolean }>(
  templates: T[],
): {
  formats: T[];
  overviews: T[];
} {
  return {
    formats: templates.filter((template) => !template.hasAssignments),
    overviews: templates.filter((template) => template.hasAssignments),
  };
}

export function pickPinnedWeekTemplate<
  T extends { year: number; week: number; createdAtMs: number },
>(templates: T[], current: { year: number; week: number }): T | undefined {
  const currentWeek = templates.filter(
    (template) => template.year === current.year && template.week === current.week,
  );
  if (currentWeek.length > 0) {
    return [...currentWeek].sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
  }
  return templates[0];
}

export function formatSendWindowCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Mon–Fri civil range for an ISO week title, e.g. `2026 W36 (08.31-09.04)`. */
export function formatOfferSendWeekTitle(year: number, week: number): string {
  const monday = isoWeekMonday(year, week);
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  const md = (date: Date) =>
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}`;
  return `${year} W${week} (${md(monday)}-${md(friday)})`;
}

function shanghaiCivilInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - SHANGHAI_OFFSET_HOURS, minute, 0));
}

/** This ISO week's send / preview window (Asia/Shanghai).
 * Scheduled send: the hour before sendTime (countdown to auto-send).
 * Manual-only: from sendTime until midnight.
 */
export function weeklySendWindow(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  timeZone?: string;
}): { start: Date; end: Date } | null {
  if (input.sendWeekday < 1 || input.sendWeekday > 7) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(input.sendTime);
  if (!match) return null;
  const timeZone = input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE;
  const calendar = zonedCalendarDate(input.now, timeZone);
  const today = zonedWeekdayAndTime(input.now, timeZone);
  const deltaDays = input.sendWeekday - today.weekday;
  const sendDay = new Date(calendar);
  sendDay.setDate(sendDay.getDate() + deltaDays);
  const sendHour = Number(match[1]);
  const sendMinute = Number(match[2]);
  const sendInstant = shanghaiCivilInstant(
    sendDay.getFullYear(),
    sendDay.getMonth() + 1,
    sendDay.getDate(),
    sendHour,
    sendMinute,
  );
  if (input.scheduleEnabled) {
    return { start: new Date(sendInstant.getTime() - 3600_000), end: sendInstant };
  }
  const start = sendInstant;
  const end = shanghaiCivilInstant(
    sendDay.getFullYear(),
    sendDay.getMonth() + 1,
    sendDay.getDate() + 1,
    0,
    0,
  );
  return { start, end };
}

function weeklyManualSendDayEnd(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  timeZone?: string;
}): Date | null {
  const preview = weeklySendWindow({ ...input, scheduleEnabled: true });
  if (!preview) return null;
  const calendar = zonedCalendarDate(input.now, input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE);
  const today = zonedWeekdayAndTime(input.now, input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE);
  const deltaDays = input.sendWeekday - today.weekday;
  const sendDay = new Date(calendar);
  sendDay.setDate(sendDay.getDate() + deltaDays);
  return shanghaiCivilInstant(
    sendDay.getFullYear(),
    sendDay.getMonth() + 1,
    sendDay.getDate() + 1,
    0,
    0,
  );
}

export function isInWeeklySendWindow(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  timeZone?: string;
}): boolean {
  const window = weeklySendWindow(input);
  if (!window) return false;
  return (
    input.now.getTime() >= window.start.getTime() && input.now.getTime() < window.end.getTime()
  );
}

/**
 * Top chip highlight + countdown: applied, not yet sent, and inside the preview
 * hour (scheduled) or the manual sendTime→midnight window. A Leader edit that
 * cancelled auto-send removes the countdown highlight.
 */
export function isWeeklySendArmed(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied || input.alreadySent || input.autoSendCancelled) return false;
  return isInWeeklySendWindow({
    now: input.now,
    sendWeekday: input.sendWeekday,
    sendTime: input.sendTime,
    scheduleEnabled: input.scheduleEnabled,
  });
}

/** Manual send after preview start (scheduled) or sendTime (manual-only), until midnight. */
export function canSendWeeklyAssignmentsNow(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  autoSendCancelled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied || input.alreadySent) return false;
  if (!input.scheduleEnabled) {
    return isInWeeklySendWindow({
      now: input.now,
      sendWeekday: input.sendWeekday,
      sendTime: input.sendTime,
      scheduleEnabled: false,
    });
  }
  const preview = weeklySendWindow({
    now: input.now,
    sendWeekday: input.sendWeekday,
    sendTime: input.sendTime,
    scheduleEnabled: true,
  });
  const dayEnd = weeklyManualSendDayEnd(input);
  if (!preview || !dayEnd) return false;
  return input.now.getTime() >= preview.start.getTime() && input.now.getTime() < dayEnd.getTime();
}
