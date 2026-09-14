import {
  WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
  zonedCalendarDate,
  zonedWeekdayAndTime,
} from "../../server/records/weekly-report-schedule-due";

/** Shanghai has no DST; civil time is UTC+8. */
const SHANGHAI_OFFSET_HOURS = 8;

export function currentWeekTemplateTitle(year: number, week: number): string {
  return `${year} W${week} 模板`;
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

function shanghaiCivilInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - SHANGHAI_OFFSET_HOURS, minute, 0));
}

/** This ISO week's send window (Asia/Shanghai).
 * Scheduled send: the whole send weekday. Manual-only: from sendTime until midnight.
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
  const startHour = input.scheduleEnabled ? 0 : Number(match[1]);
  const startMinute = input.scheduleEnabled ? 0 : Number(match[2]);
  const start = shanghaiCivilInstant(
    sendDay.getFullYear(),
    sendDay.getMonth() + 1,
    sendDay.getDate(),
    startHour,
    startMinute,
  );
  const end = shanghaiCivilInstant(
    sendDay.getFullYear(),
    sendDay.getMonth() + 1,
    sendDay.getDate() + 1,
    0,
    0,
  );
  return { start, end };
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
 * Top chip +「发送给成员」: applied settings, inside the send-day window, and
 * this week's send has not run yet (manual or scheduled). After send, chip grays out.
 */
export function isWeeklySendArmed(input: {
  applied: boolean;
  alreadySent: boolean;
  sendWeekday: number;
  sendTime: string;
  scheduleEnabled?: boolean;
  now: Date;
}): boolean {
  if (!input.applied || input.alreadySent) return false;
  return isInWeeklySendWindow({
    now: input.now,
    sendWeekday: input.sendWeekday,
    sendTime: input.sendTime,
    scheduleEnabled: input.scheduleEnabled,
  });
}
