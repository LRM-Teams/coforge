import { hasErrorCode, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { RuntimeModelNotFoundError } from "#src/code-agent/contract";
import { fingerprintRuntimeError, scrubRuntimeErrorText } from "./runtime-error-activity";
import { RUNTIME_ERROR_CLASS } from "./runtime-error-classification";

/**
 * Reads the classified launch evidence the agent SDK attaches to a `PiLaunchError` (see
 * packages/agent/src/launch-error.ts), on the error itself or on the error it is the `cause` of
 * (the Pi provider wraps it in a typed launch error), as structured log fields.
 *
 * The fields are duck-typed and deliberately conservative: only exactly-typed
 * `policyCode`/`trace` members surface; nothing sensitive is ever included.
 */
export type LaunchFailureTrace = {
  /** e.g. "PI_LAUNCH_MODEL_MISSING" — only set when the SDK classified the launch. */
  launchCategory?: string;
  provider?: string;
  providerPresent?: boolean;
  providerKeyPresent?: boolean;
  baseUrlPresent?: boolean;
  modelPresent?: boolean;
};

export function launchFailureTrace(error: unknown): LaunchFailureTrace {
  const own = ownLaunchFailureTrace(error);
  if (own || !(error instanceof Error)) return own ?? {};
  return ownLaunchFailureTrace(error.cause) ?? {};
}

function ownLaunchFailureTrace(error: unknown): LaunchFailureTrace | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  const policyCode = typeof err.policyCode === "string" ? err.policyCode : undefined;
  const rawTrace = err.trace;
  const trace: Record<string, unknown> =
    rawTrace && typeof rawTrace === "object" ? (rawTrace as Record<string, unknown>) : {};
  if (!policyCode && Object.keys(trace).length === 0) return undefined;
  return {
    launchCategory: policyCode,
    provider: typeof trace.provider === "string" ? trace.provider : undefined,
    providerPresent: typeof trace.providerPresent === "boolean" ? trace.providerPresent : undefined,
    providerKeyPresent:
      typeof trace.providerKeyPresent === "boolean" ? trace.providerKeyPresent : undefined,
    baseUrlPresent: typeof trace.baseUrlPresent === "boolean" ? trace.baseUrlPresent : undefined,
    modelPresent: typeof trace.modelPresent === "boolean" ? trace.modelPresent : undefined,
  };
}

/**
 * Why a launch could not start, as a stable code: the `errorReason` of the launch failure's
 * `runtimeError` (class `LauncherError`), so a reader picks the explanation by code and never
 * parses `detail`. Each value except the fallback is the `code` of a typed launch error thrown
 * where the failure is known: `AgentAuthorizationError` below, `RuntimeExecutableNotFoundError`
 * in the spawner, and the typed errors in `code-agent/contract.ts`.
 */
export const LAUNCH_FAILURE_REASON = {
  /** The daemon could not obtain the Agent's launch configuration and API key from the server. */
  AGENT_AUTHORIZATION_FAILED: "agent_authorization_failed",
  /** The spawner could not find the runtime's executable on the Agent's PATH. */
  RUNTIME_NOT_FOUND: "runtime_not_found",
  /** The runtime's CLI is older than the version CoForge supports. */
  RUNTIME_VERSION_TOO_OLD: "runtime_version_too_old",
  /** The runtime on this Computer does not offer the Agent's configured model. */
  MODEL_NOT_FOUND: "model_not_found",
  /** The runtime cannot use the Agent's model provider setting. */
  MODEL_PROVIDER_NOT_CONFIGURED: "model_provider_not_configured",
  /** No typed error said why. */
  RUNTIME_SPAWN_FAILED: "runtime_spawn_failed",
} as const;
export type LaunchFailureReason =
  (typeof LAUNCH_FAILURE_REASON)[keyof typeof LAUNCH_FAILURE_REASON];

const TYPED_REASONS: readonly LaunchFailureReason[] = [
  LAUNCH_FAILURE_REASON.AGENT_AUTHORIZATION_FAILED,
  LAUNCH_FAILURE_REASON.RUNTIME_NOT_FOUND,
  LAUNCH_FAILURE_REASON.RUNTIME_VERSION_TOO_OLD,
  LAUNCH_FAILURE_REASON.MODEL_NOT_FOUND,
  LAUNCH_FAILURE_REASON.MODEL_PROVIDER_NOT_CONFIGURED,
];

/** The server did not hand this launch its configuration and Agent API key. */
export class AgentAuthorizationError extends Error {
  readonly code = LAUNCH_FAILURE_REASON.AGENT_AUTHORIZATION_FAILED;
  constructor(cause: unknown) {
    super(
      `Agent launch configuration could not be obtained: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AgentAuthorizationError";
  }
}

/** The launch failure reason a typed error carries, or `runtime_spawn_failed`. */
export function launchFailureReason(error: unknown): LaunchFailureReason {
  return (
    TYPED_REASONS.find((reason) => hasErrorCode(error, reason)) ??
    LAUNCH_FAILURE_REASON.RUNTIME_SPAWN_FAILED
  );
}

/** Longest model name a launch failure repeats back. */
const MODEL_NAME_LIMIT = 128;

/** What happened and what the person can do next, for the Activity `detail`. */
function launchFailureDetail(
  reason: LaunchFailureReason,
  error: unknown,
  runtimeName: string,
): string {
  switch (reason) {
    case LAUNCH_FAILURE_REASON.AGENT_AUTHORIZATION_FAILED:
      return (
        "Agent authorization could not be prepared: this Computer could not obtain the Agent's " +
        "launch credentials from the server. Check the Workspace connection and this Computer's " +
        "version with `coforge-computer status`; if the Computer is behind the server, update it " +
        "with `coforge-computer upgrade`, then start the Agent again."
      );
    case LAUNCH_FAILURE_REASON.RUNTIME_NOT_FOUND:
      return (
        `${runtimeName} is not installed on this Computer, or it is not on the PATH the ` +
        `Computer starts Agents with. Install ${runtimeName}, then start the Agent again.`
      );
    case LAUNCH_FAILURE_REASON.RUNTIME_VERSION_TOO_OLD:
      // The version gate's own sentence names both versions and what to upgrade.
      return error instanceof Error ? error.message : `${runtimeName} is too old.`;
    case LAUNCH_FAILURE_REASON.MODEL_NOT_FOUND: {
      const model = error instanceof RuntimeModelNotFoundError ? error.model : "";
      return (
        `Model ${truncateCodePoints(model || "the configured model", MODEL_NAME_LIMIT)} is not ` +
        `available to ${runtimeName} on this Computer. Choose another model in the Agent's ` +
        "settings, then start it again."
      );
    }
    case LAUNCH_FAILURE_REASON.MODEL_PROVIDER_NOT_CONFIGURED:
      return (
        `${runtimeName} cannot use the Agent's model provider setting. Configure the model ` +
        "provider in the Agent's settings, then start it again."
      );
    case LAUNCH_FAILURE_REASON.RUNTIME_SPAWN_FAILED:
      return (
        "Agent runtime could not be started. See `coforge-computer logs` for the cause, then " +
        "start the Agent again."
      );
  }
}

/** The error Activity content for a launch that did not start: the sentence that explains it
 * and the typed reason beside it. */
export function launchFailureActivity(
  error: unknown,
  runtimeName: string,
): {
  detail: string;
  runtimeError: { errorClass: string; errorReason: LaunchFailureReason; fingerprint: string };
} {
  const reason = launchFailureReason(error);
  const detail = launchFailureDetail(reason, error, runtimeName);
  return {
    detail,
    runtimeError: {
      errorClass: RUNTIME_ERROR_CLASS.LAUNCHER,
      errorReason: reason,
      fingerprint: fingerprintRuntimeError(detail),
    },
  };
}

/** The structured log fields for a failed launch: its reason, its redacted message (the cause the
 * Activity sends people to the Computer log for), and any SDK trace evidence. */
export function launchFailureLogFields(error: unknown) {
  return {
    failure_reason: launchFailureReason(error),
    error_message: scrubRuntimeErrorText(error instanceof Error ? error.message : String(error)),
    ...launchFailureTrace(error),
  };
}
