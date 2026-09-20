/**
 * Reads the classified launch-failure evidence that the agent SDK attaches to a
 * `PiLaunchError` (see packages/agent/src/launch-error.ts) and turns it into
 * daemon-side structured log fields / a safe user-facing phrase. This replaces the
 * opaque `error_code "23"` (a bare SDK TimeoutError) with a categorized, diagnosable
 * failure.
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
  if (!error || typeof error !== "object") return {};
  const err = error as Record<string, unknown>;
  const policyCode = typeof err.policyCode === "string" ? err.policyCode : undefined;
  const rawTrace = err.trace;
  const trace: Record<string, unknown> =
    rawTrace && typeof rawTrace === "object" ? (rawTrace as Record<string, unknown>) : {};
  if (!policyCode && Object.keys(trace).length === 0) return {};
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

const LAUNCH_CATEGORY_TEXT: Record<string, string> = {
  PI_LAUNCH_PROVIDER_MISSING: "model provider is not configured in the local model catalog",
  PI_LAUNCH_PROVIDER_UNCONFIGURED: "model provider has no configured credentials",
  PI_LAUNCH_MODEL_MISSING: "the selected model is not available in the local model catalog",
  PI_LAUNCH_TIMEOUT: "model provider refresh timed out",
  PI_LAUNCH_SPAWN_FAILED: "the model runtime failed to start",
};

export function launchCategoryText(policyCode: string | undefined): string | undefined {
  return policyCode ? LAUNCH_CATEGORY_TEXT[policyCode] : undefined;
}
