import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";

/** Local proxy / CLI body for personal key-point extraction write-back. */
export type WeeklyReportKeyPointsCommand = {
  requestId: string;
  reportId: string;
  markdown: string;
};

export type WeeklyReportKeyPointsResult = {
  requestId: string;
  reportId: string;
  status: string;
};

/** Validates the Agent HTTPS / proxy key-points body before forwarding to cloud. */
export function validateWeeklyReportKeyPointsCommand(
  payload: Record<string, unknown>,
): WeeklyReportKeyPointsCommand | null {
  if (typeof payload.requestId !== "string" || !RFC_UUID_PATTERN.test(payload.requestId))
    return null;
  if (typeof payload.reportId !== "string" || !RFC_UUID_PATTERN.test(payload.reportId)) return null;
  if (
    typeof payload.markdown !== "string" ||
    payload.markdown.trim().length === 0 ||
    payload.markdown.length > 500_000
  )
    return null;
  return {
    requestId: payload.requestId,
    reportId: payload.reportId,
    markdown: payload.markdown,
  };
}
