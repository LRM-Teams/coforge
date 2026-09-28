import { RFC_UUID_PATTERN, WEEKLY_REPORT_MARKDOWN_MAX_CHARS } from "@lrm/coforge-sdk/internal";

/** Local proxy / CLI body for Collect Run pack submit (ADR 0032 HTTPS return path). */
export type WeeklyReportCollectCommand = {
  idempotencyKey: string;
  runId: string;
  outcome: "ready" | "empty" | "failed";
  packMarkdown?: string;
  failureReason?: string;
};

/** Daemon turn-fail path: fail every still-running Collect slot for this Agent. */
export type WeeklyReportCollectFailRunningCommand = {
  idempotencyKey: string;
  failRunningSlots: true;
  failureReason: string;
};

export type WeeklyReportCollectResult = {
  idempotencyKey: string;
  runId: string;
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
  slotCount?: number;
  waveExhausted?: boolean;
};

/** Validates the Agent HTTPS / proxy collect body before forwarding to cloud. */
export function validateWeeklyReportCollectCommand(
  payload: Record<string, unknown>,
): WeeklyReportCollectCommand | null {
  if (typeof payload.idempotencyKey !== "string" || !RFC_UUID_PATTERN.test(payload.idempotencyKey))
    return null;
  if (typeof payload.runId !== "string" || !RFC_UUID_PATTERN.test(payload.runId)) return null;
  if (payload.outcome !== "ready" && payload.outcome !== "empty" && payload.outcome !== "failed")
    return null;
  if (
    payload.packMarkdown !== undefined &&
    (typeof payload.packMarkdown !== "string" ||
      payload.packMarkdown.length > WEEKLY_REPORT_MARKDOWN_MAX_CHARS)
  )
    return null;
  if (
    payload.failureReason !== undefined &&
    (typeof payload.failureReason !== "string" || payload.failureReason.length > 2000)
  )
    return null;
  if (payload.outcome === "ready" && typeof payload.packMarkdown !== "string") return null;
  if (payload.outcome === "failed" && typeof payload.failureReason !== "string") return null;
  return {
    idempotencyKey: payload.idempotencyKey,
    runId: payload.runId,
    outcome: payload.outcome,
    ...(typeof payload.packMarkdown === "string" ? { packMarkdown: payload.packMarkdown } : {}),
    ...(typeof payload.failureReason === "string" ? { failureReason: payload.failureReason } : {}),
  };
}

export function validateWeeklyReportCollectFailRunningCommand(
  payload: Record<string, unknown>,
): WeeklyReportCollectFailRunningCommand | null {
  if (typeof payload.idempotencyKey !== "string" || !RFC_UUID_PATTERN.test(payload.idempotencyKey))
    return null;
  if (payload.failRunningSlots !== true) return null;
  if (typeof payload.failureReason !== "string" || payload.failureReason.length === 0) return null;
  if (payload.failureReason.length > 2000) return null;
  return {
    idempotencyKey: payload.idempotencyKey,
    failRunningSlots: true,
    failureReason: payload.failureReason,
  };
}
