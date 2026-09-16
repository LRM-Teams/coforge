import { m } from "@/paraglide/messages";
import { isAppError } from "@/lib/app-error";

/** Why an upgrade request ended without a verified new Computer version. */
export type ComputerUpgradeFailure = {
  reason: "timeout" | "publication" | "evidence" | "reported";
  error?: string;
};

// Only "reported" carries the Computer's own account of what went wrong; the rest are what the
// server could infer from a Computer that never came back with the expected version.
const REASONS: Record<ComputerUpgradeFailure["reason"], () => string> = {
  reported: m.computer_upgrade_failed_reported,
  timeout: m.computer_upgrade_failed_timeout,
  publication: m.computer_upgrade_failed_publication,
  evidence: m.computer_upgrade_failed_evidence,
};

/**
 * One line a Workspace member can act on. Request IDs, stage lists, and timing stay in the logs
 * and in the machine's own result files; the failure text is already sanitized of local paths.
 */
export function describeComputerUpgradeFailure(failure: ComputerUpgradeFailure): string {
  const headline = (REASONS[failure.reason] ?? m.computer_upgrade_failed_unknown)();
  return failure.error ? `${headline}: ${failure.error}` : `${headline}.`;
}

/**
 * The one-line toast confirmation for a completed upgrade. Per docs/ui-guidelines.md §13, the
 * version itself belongs to the meta line (the caller re-fetches once the status is completed);
 * this is only the courtesy that the action the user took just succeeded, never a second,
 * inline echo of the same event.
 */
export function describeComputerUpgradeSuccess(version: string): string {
  return m.computer_upgrade_succeeded_toast({ version });
}

/** One line and an optional reference id, never the raw `COFORGE_APP_ERROR:` wire encoding. */
export type UpgradeRequestErrorCopy = { headline: string; errorId?: string };

/**
 * Why the upgrade request itself never got off the ground - the Computer was unreachable, the
 * release feed failed, or something else broke before an operation could even be registered.
 * A decoded AppError maps to a sentence a Workspace member can act on, with its `errorId` kept
 * as a quiet reference; anything else (including the synthetic errors this module raises while
 * polling a terminal status, via `describeComputerUpgradeFailure`) is already a finished
 * sentence and passes through unchanged.
 */
export function describeUpgradeRequestError(error: unknown): UpgradeRequestErrorCopy {
  if (isAppError(error)) {
    if (error.code === "COMPUTER_OFFLINE")
      return { headline: m.computer_upgrade_offline(), errorId: error.errorId };
    if (error.code === "RELEASE_FEED_UNAVAILABLE")
      return { headline: m.computer_upgrade_feed_unavailable(), errorId: error.errorId };
    return { headline: m.computer_upgrade_request_failed(), errorId: error.errorId };
  }
  return {
    headline: error instanceof Error ? error.message : m.computer_upgrade_failed_unknown(),
  };
}
