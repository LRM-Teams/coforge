import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Stable, human-readable classification of a model-runtime launch failure.
 *
 * This is the Raft-aligned answer to an opaque `error_code "23"` (a bare SDK
 * TimeoutError that required archaeology to diagnose): instead the failure is
 * categorized and accompanied by non-sensitive trace evidence (`provider_key_present`,
 * `base_url_present`, model presence) derived from the local model catalog.
 */
export type PiLaunchCategory =
  | "provider_missing"
  | "provider_unconfigured"
  | "model_missing"
  | "timeout"
  | "spawn_failed";

/** Non-sensitive trace evidence about the launch configuration; safe to surface. */
export type PiLaunchTrace = {
  provider: string;
  model: string;
  /** The requested provider id exists in the local model catalog. */
  providerPresent: boolean;
  /** The requested provider has a configured credential (api key / oauth). */
  providerKeyPresent: boolean;
  /** The requested provider declares a base URL. */
  baseUrlPresent: boolean;
  /** The requested model id resolves in the provider's model list. */
  modelPresent: boolean;
};

export function piLaunchTrace(
  runtime: ModelRuntime,
  provider: string | undefined,
  model: string | undefined,
): PiLaunchTrace {
  const providerId = provider ?? "";
  const modelId = model ?? "";
  const providerEntry = providerId
    ? runtime.getProviders().find((entry) => entry.id === providerId)
    : undefined;
  const providerPresent = providerEntry !== undefined;
  const providerKeyPresent = providerPresent ? runtime.hasConfiguredAuth(providerId) : false;
  const baseUrlPresent = Boolean(providerEntry?.baseUrl?.trim());
  const modelPresent = Boolean(
    providerId && modelId && runtime.getModel(providerId, modelId) !== undefined,
  );
  return {
    provider: providerId,
    model: modelId,
    providerPresent,
    providerKeyPresent,
    baseUrlPresent,
    modelPresent,
  };
}

/** A launch failure carrying a stable lower-cardinality code + trace evidence. */
export class PiLaunchError extends Error {
  readonly trace: PiLaunchTrace;
  readonly policyCode: string;

  constructor(category: PiLaunchCategory, trace: PiLaunchTrace, message: string) {
    super(message);
    this.name = "PiLaunchError";
    this.trace = trace;
    this.policyCode = `PI_LAUNCH_${category.toUpperCase().replaceAll("-", "_")}`;
  }
}

/** Classifies a throwable into a PiLaunchError using the launch config trace. */
export function classifyPiLaunchFailure(
  runtime: ModelRuntime,
  provider: string | undefined,
  model: string | undefined,
  cause?: unknown,
): PiLaunchError {
  const trace = piLaunchTrace(runtime, provider, model);
  let category: PiLaunchCategory;
  let detail: string;

  const timedOut = isTimeout(cause);
  if (timedOut) {
    category = "timeout";
    detail = "Pi model runtime timed out while resolving the provider catalog.";
  } else if (!provider) {
    category = "provider_missing";
    detail = "Pi model launch did not specify a model provider.";
  } else if (!trace.providerPresent) {
    category = "provider_missing";
    detail = `Pi provider "${provider}" is not configured in the local model catalog.`;
  } else if (isModelUnavailable(cause)) {
    category = "model_missing";
    detail = `Pi model not found: ${model ?? "(none)"}`;
  } else if (!trace.providerKeyPresent && !trace.baseUrlPresent) {
    category = "provider_unconfigured";
    detail = `Pi provider "${provider}" has no usable credentials or base URL in the local model catalog.`;
  } else if (!trace.modelPresent) {
    category = "model_missing";
    detail = `Pi model not found: ${model} (provider \"${provider}\")`;
  } else {
    category = "spawn_failed";
    detail = "Pi model runtime failed to start.";
  }
  return new PiLaunchError(category, trace, detail);
}

/** Marks the bare "Pi model is unavailable" guard as a model-missing classification. */
export const PI_MODEL_UNAVAILABLE = Symbol("PiModelUnavailable");

function isModelUnavailable(cause: unknown): boolean {
  return (
    cause === PI_MODEL_UNAVAILABLE ||
    Boolean(
      cause &&
      typeof cause === "object" &&
      (cause as { name?: string }).name === "PiModelUnavailable",
    )
  );
}

function isTimeout(cause: unknown): boolean {
  if (!cause) return false;
  const name = (cause as { name?: string }).name;
  const code = (cause as { code?: string }).code;
  const message = (cause as { message?: string }).message ?? "";
  return (
    name === "TimeoutError" ||
    code === "23" ||
    code === "ETIMEDOUT" ||
    message.toLowerCase().includes("timed out") ||
    message.toLowerCase().includes("timeout")
  );
}
