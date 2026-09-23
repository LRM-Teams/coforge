/** Local proxy / CLI body for Collect Run pack submit (ADR 0032 HTTPS return path). */
export type WeeklyReportCollectCommand = {
  requestId: string;
  runId: string;
  outcome: "ready" | "empty" | "failed";
  packMarkdown?: string;
  failureReason?: string;
};

/** Daemon turn-fail path: fail every still-running Collect slot for this Agent. */
export type WeeklyReportCollectFailRunningCommand = {
  requestId: string;
  failRunningSlots: true;
  failureReason: string;
};

export type WeeklyReportCollectResult = {
  requestId: string;
  runId: string;
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
  slotCount?: number;
  waveExhausted?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates the Agent HTTPS / proxy collect body before forwarding to cloud. */
export function validateWeeklyReportCollectCommand(
  payload: Record<string, unknown>,
): WeeklyReportCollectCommand | null {
  if (typeof payload.requestId !== "string" || !UUID.test(payload.requestId)) return null;
  if (typeof payload.runId !== "string" || !UUID.test(payload.runId)) return null;
  if (payload.outcome !== "ready" && payload.outcome !== "empty" && payload.outcome !== "failed")
    return null;
  if (
    payload.packMarkdown !== undefined &&
    (typeof payload.packMarkdown !== "string" || payload.packMarkdown.length > 500_000)
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
    requestId: payload.requestId,
    runId: payload.runId,
    outcome: payload.outcome,
    ...(typeof payload.packMarkdown === "string" ? { packMarkdown: payload.packMarkdown } : {}),
    ...(typeof payload.failureReason === "string" ? { failureReason: payload.failureReason } : {}),
  };
}

export function validateWeeklyReportCollectFailRunningCommand(
  payload: Record<string, unknown>,
): WeeklyReportCollectFailRunningCommand | null {
  if (typeof payload.requestId !== "string" || !UUID.test(payload.requestId)) return null;
  if (payload.failRunningSlots !== true) return null;
  if (typeof payload.failureReason !== "string" || payload.failureReason.length === 0) return null;
  if (payload.failureReason.length > 2000) return null;
  return {
    requestId: payload.requestId,
    failRunningSlots: true,
    failureReason: payload.failureReason,
  };
}
