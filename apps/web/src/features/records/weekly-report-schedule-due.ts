/** Fixed schedule clock for MVP periodic weekly-report send. */
export const WEEKLY_REPORT_SCHEDULE_TIME_ZONE = "Asia/Shanghai";

const WEEKDAY_SHORT_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function zonedWeekdayAndTime(
  now: Date,
  timeZone: string = WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const byType = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAY_SHORT_TO_ISO[byType.weekday ?? ""];
  if (!weekday) throw new Error(`unexpected weekday: ${byType.weekday}`);
  const hour = byType.hour ?? "00";
  const minute = byType.minute ?? "00";
  return { weekday, time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` };
}

/** Calendar date components in the schedule timezone (for ISO week alignment). */
export function zonedCalendarDate(
  now: Date,
  timeZone: string = WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return new Date(Number(byType.year), Number(byType.month) - 1, Number(byType.day), 12, 0, 0);
}

/** True when local weekday matches and local clock is at or after sendTime. */
export function isWeeklyScheduleDue(input: {
  now: Date;
  sendWeekday: number;
  sendTime: string;
  timeZone?: string;
}): boolean {
  if (input.sendWeekday < 1 || input.sendWeekday > 7) return false;
  if (!/^\d{2}:\d{2}$/.test(input.sendTime)) return false;
  const { weekday, time } = zonedWeekdayAndTime(
    input.now,
    input.timeZone ?? WEEKLY_REPORT_SCHEDULE_TIME_ZONE,
  );
  return weekday === input.sendWeekday && time >= input.sendTime;
}
