import { m } from "@/paraglide/messages";
import { isAppError } from "@/lib/app-error";
import {
  UPGRADE_ERROR_CODE,
  parseUpgradeErrorCode,
  type UpgradeErrorCode,
} from "@lrm/coforge-sdk/internal";

/** Why an upgrade request ended without a verified new Computer version. */
export type ComputerUpgradeFailure = {
  reason: "timeout" | "publication" | "evidence" | "reported";
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. Only ever meaningful alongside `reason: "reported"` - it is the
   * Daemon's own account of why, carried from wherever it actually happened, never a code this
   * module invents. */
  errorCode?: string;
};

/** One next step a Workspace member can take: a sentence, and - when the fix really is a real
 * `coforge-computer` command - that exact command string, rendered in the app's mono command
 * style with its copy affordance. Never a raw code, never a wire string. */
export type UpgradeFailureStep = { text: string; command?: string };

/** What renders inline where an upgrade failure shows today: a headline sentence, then an
 * ordered list of next steps. */
export type UpgradeFailureView = { headline: string; steps: UpgradeFailureStep[] };

const COMMAND = {
  status: "coforge-computer status",
  start: "coforge-computer start",
  logs: "coforge-computer logs",
  upgrade: "coforge-computer upgrade",
  restartSupervisor: "coforge-computer restart --supervisor",
} as const;

/**
 * Carries a fully-composed view through the same throw/catch `computer-detail.tsx`'s `runUpgrade`
 * already uses for a terminal polled failure, instead of collapsing the view into an `Error`'s
 * message string (which cannot carry a steps list). `describeUpgradeRequestError` recognizes this
 * type and returns its view unchanged.
 */
export class ComputerUpgradeFailureView extends Error {
  constructor(readonly view: UpgradeFailureView) {
    super(view.headline);
    this.name = "ComputerUpgradeFailureView";
  }
}

/**
 * Every reason the server itself can report, independent of anything the Computer said. Steps
 * match what a Workspace member can actually do about each one; the "reported" entry is the
 * fallback used only when the Computer's own `errorCode` is absent or not (yet) known to this
 * build - `describeComputerUpgradeFailure` prefers `CODE_COPY` over this whenever it can.
 */
const REASON_COPY: Record<ComputerUpgradeFailure["reason"], () => UpgradeFailureView> = {
  timeout: () => ({
    headline: m.computer_upgrade_failed_timeout(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_upgrade_by_hand(), command: COMMAND.upgrade },
    ],
  }),
  publication: () => ({
    headline: m.computer_upgrade_failed_publication(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_start_if_stopped(), command: COMMAND.start },
    ],
  }),
  evidence: () => ({
    headline: m.computer_upgrade_failed_evidence(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_upgrade_by_hand(), command: COMMAND.upgrade },
    ],
  }),
  reported: () => ({
    headline: m.computer_upgrade_failed_reported(),
    steps: [
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
};

/**
 * Every code a Daemon-reported failure (`reason: "reported"`) can carry, exhaustively - a new
 * `UpgradeErrorCode` value fails `tsc` here rather than silently falling back to generic copy.
 * See `packages/coforge-sdk/src/internal/index.ts`'s `UPGRADE_ERROR_CODE` for each one's owner
 * and real throw site.
 */
const CODE_COPY: Record<UpgradeErrorCode, () => UpgradeFailureView> = {
  [UPGRADE_ERROR_CODE.OPERATION_PENDING]: () => ({
    // Not a failure: the Daemon refused because another upgrade is genuinely still in flight (it
    // settles any already-settle-able blocker itself, so reaching here means the other operation is
    // running right now). Reporting it as "the previous upgrade's result has not been confirmed"
    // read as a failure and sent people off to restart the Supervisor *while an upgrade was
    // running* - on a real machine a healthy upgrade takes about two minutes, which is longer than
    // this panel used to wait. The advice is now to wait, with the restart kept for a stuck one.
    headline: m.computer_upgrade_code_operation_pending(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_wait_running() },
      {
        text: m.computer_upgrade_step_restart_supervisor_retry(),
        command: COMMAND.restartSupervisor,
      },
    ],
  }),
  [UPGRADE_ERROR_CODE.LAUNCHES_PAUSED]: () => ({
    headline: m.computer_upgrade_code_launches_paused(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_wait_running() },
    ],
  }),
  [UPGRADE_ERROR_CODE.LAUNCH_FAILED]: () => ({
    headline: m.computer_upgrade_code_launch_failed(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.UPDATE_BUSY]: () => ({
    headline: m.computer_upgrade_code_update_busy(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.UPDATE_FEED_INVALID]: () => ({
    headline: m.computer_upgrade_code_update_feed_invalid(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED]: () => ({
    headline: m.computer_upgrade_code_update_integrity_failed(),
    steps: [
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.UPDATE_NO_ROLLBACK]: () => ({
    headline: m.computer_upgrade_code_update_no_rollback(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.UPDATE_UNSUPPORTED_TARGET]: () => ({
    headline: m.computer_upgrade_code_update_unsupported_target(),
    steps: [{ text: m.computer_upgrade_step_check_status(), command: COMMAND.status }],
  }),
  [UPGRADE_ERROR_CODE.ROLLED_BACK]: () => ({
    headline: m.computer_upgrade_code_rolled_back(),
    steps: [
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
  [UPGRADE_ERROR_CODE.ROLLBACK_FAILED]: () => ({
    headline: m.computer_upgrade_code_rollback_failed(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_check_logs(), command: COMMAND.logs },
      { text: m.computer_upgrade_step_manual_recovery() },
    ],
  }),
  [UPGRADE_ERROR_CODE.EXPIRED_WITHOUT_RECEIPT]: () => ({
    headline: m.computer_upgrade_code_expired_without_receipt(),
    steps: [
      { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
      { text: m.computer_upgrade_step_retry_upgrade(), command: COMMAND.upgrade },
    ],
  }),
};

/**
 * One line and steps a Workspace member can act on. Request IDs, stage lists, and timing stay in
 * the logs and in the machine's own result files; the failure text is already sanitized of local
 * paths. A known `errorCode` (only ever set on `reason: "reported"`) takes over the generic
 * "reported" copy; an unknown one falls back to it, appending the Computer's own sanitized text
 * exactly as the generic case always has.
 */
export function describeComputerUpgradeFailure(
  failure: ComputerUpgradeFailure,
): UpgradeFailureView {
  const knownCode =
    failure.reason === "reported" ? parseUpgradeErrorCode(failure.errorCode) : undefined;
  if (knownCode) return CODE_COPY[knownCode]();
  const generic = (
    REASON_COPY[failure.reason] ??
    (() => ({
      headline: m.computer_upgrade_failed_unknown(),
      steps: [{ text: m.computer_upgrade_step_check_status(), command: COMMAND.status }],
    }))
  )();
  return {
    ...generic,
    headline: failure.error ? `${generic.headline}: ${failure.error}` : `${generic.headline}.`,
  };
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

/** An `UpgradeFailureView` plus an optional quiet error reference id, never the raw
 * `COFORGE_APP_ERROR:` wire encoding. */
export type UpgradeRequestErrorCopy = UpgradeFailureView & { errorId?: string };

/**
 * Why the upgrade request itself never got off the ground - the Computer was unreachable, the
 * release feed failed, or something else broke before an operation could even be registered - or
 * why a terminal poll gave up (`ComputerUpgradeFailureView`, from `describeComputerUpgradeFailure`
 * above). A decoded `AppError` maps to a sentence and steps a Workspace member can act on, with
 * its `errorId` kept as a quiet reference; anything else is rendered from its own message with no
 * steps.
 */
export function describeUpgradeRequestError(error: unknown): UpgradeRequestErrorCopy {
  if (error instanceof ComputerUpgradeFailureView) return error.view;
  if (isAppError(error)) {
    if (error.code === "COMPUTER_OFFLINE")
      return {
        headline: m.computer_upgrade_offline(),
        steps: [
          { text: m.computer_upgrade_step_check_status(), command: COMMAND.status },
          { text: m.computer_upgrade_step_start_if_stopped(), command: COMMAND.start },
        ],
        errorId: error.errorId,
      };
    if (error.code === "COMPUTER_IDENTITY_UNKNOWN")
      return {
        headline: m.computer_upgrade_identity_unknown(),
        steps: [
          {
            text: m.computer_upgrade_step_restart_supervisor(),
            command: COMMAND.restartSupervisor,
          },
        ],
        errorId: error.errorId,
      };
    if (error.code === "RELEASE_FEED_UNAVAILABLE")
      return { headline: m.computer_upgrade_feed_unavailable(), steps: [], errorId: error.errorId };
    return { headline: m.computer_upgrade_request_failed(), steps: [], errorId: error.errorId };
  }
  return {
    headline: error instanceof Error ? error.message : m.computer_upgrade_failed_unknown(),
    steps: [],
  };
}
