import { RFC_UUID_PATTERN, WEEKLY_REPORT_MARKDOWN_MAX_CHARS } from "@lrm/coforge-sdk/internal";

/** Local proxy / CLI body for personal key-point extraction write-back. */
export type WeeklyReportKeyPointsCommand = {
  idempotencyKey: string;
  reportId: string;
  markdown: string;
};

export type WeeklyReportKeyPointsResult = {
  idempotencyKey: string;
  reportId: string;
  status: string;
};

/** Validates the Agent HTTPS / proxy key-points body before forwarding to cloud. */
export function validateWeeklyReportKeyPointsCommand(
  payload: Record<string, unknown>,
): WeeklyReportKeyPointsCommand | null {
  if (typeof payload.idempotencyKey !== "string" || !RFC_UUID_PATTERN.test(payload.idempotencyKey))
    return null;
  if (typeof payload.reportId !== "string" || !RFC_UUID_PATTERN.test(payload.reportId)) return null;
  if (
    typeof payload.markdown !== "string" ||
    payload.markdown.trim().length === 0 ||
    payload.markdown.length > WEEKLY_REPORT_MARKDOWN_MAX_CHARS
  )
    return null;
  return {
    idempotencyKey: payload.idempotencyKey,
    reportId: payload.reportId,
    markdown: payload.markdown,
  };
}
