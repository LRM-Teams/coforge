/**
 * Turns a runtime failure's own text into a stable CoForge error class, a stable reason, and an
 * explicit retry decision — independent of which code-agent provider produced it. This is the one
 * place that decision is made; `runtime-error-activity.ts` uses it only when a provider has not
 * already supplied its own richer `providerErrorClass`/`providerErrorReason` hint (a provider's
 * own hint is always kept as-is), and `daemon-runtime/runtime.ts` uses it unconditionally to
 * decide whether a failure is worth backing off and retrying a held delivery for (see
 * `runtime-error-recovery.ts`), since an arbitrary provider hint string is not something this
 * table can look up.
 *
 * Table-driven and ordered: the first matching rule wins, so a more specific pattern (an
 * unsupported model, an oversized prompt) must be listed ahead of a broader one (a bare "not
 * found"). Every class maps to exactly one of the two decisions in `RUNTIME_ERROR_RETRY_DECISION`
 * — there is no third "maybe" outcome here. CoForge does not yet reproduce the reference product's
 * finer three-way split between "recoverable-but-terminal" and "permanently sticky" failures
 * (auth/model/input-size handling is a later CR's territory); this module intentionally
 * simplifies that down to retry-or-stop, and the repeat fence in `runtime-error-recovery.ts`
 * is what keeps an always-retryable class like the generic fallback from looping forever on a
 * failure that never actually clears.
 */

export const RUNTIME_ERROR_CLASS = {
  LAUNCHER: "LauncherError",
  INPUT_TOO_LARGE: "InputTooLargeError",
  AUTH: "AuthError",
  MODEL_CONFIG: "ModelConfigError",
  TIMEOUT: "TimeoutError",
  PROVIDER_CONNECTION: "ProviderConnectionError",
  PROVIDER_STREAM: "ProviderStreamError",
  RATE_LIMIT: "RateLimitError",
  PROVIDER_SERVER: "ProviderServerError",
  NOT_FOUND: "NotFoundError",
  /** Nothing below matched: keeps the pre-existing default identifier so a caller that already
   * special-cased "AgentRuntimeError"/"runtime_failure" (e.g. existing tests, dashboards) sees no
   * change for text this table still cannot explain. */
  RUNTIME: "AgentRuntimeError",
} as const;
export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASS)[keyof typeof RUNTIME_ERROR_CLASS];

export const RUNTIME_ERROR_RETRY_DECISION = {
  /** Worth holding queued deliveries for and re-attempting after a backoff (see
   * `runtime-error-recovery.ts`). */
  RETRY: "retry",
  /** Retrying this delivery achieves nothing on its own; the daemon does not back off — it
   * leaves the Agent in a truthful state instead of pretending a retry is coming. */
  TERMINAL: "terminal",
} as const;
export type RuntimeErrorRetryDecision =
  (typeof RUNTIME_ERROR_RETRY_DECISION)[keyof typeof RUNTIME_ERROR_RETRY_DECISION];

export type RuntimeErrorClassification = Readonly<{
  errorClass: RuntimeErrorClass;
  errorReason: string;
  retryDecision: RuntimeErrorRetryDecision;
}>;

type ClassificationRule = Readonly<{
  errorClass: RuntimeErrorClass;
  errorReason: string;
  retryDecision: RuntimeErrorRetryDecision;
  matches: (message: string) => boolean;
}>;

const { RETRY, TERMINAL } = RUNTIME_ERROR_RETRY_DECISION;

/** Ordered rules: the first one whose pattern matches wins. */
const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    errorClass: RUNTIME_ERROR_CLASS.LAUNCHER,
    errorReason: "launcher_error",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\b(?:ENOENT|EACCES|EPERM)\b/.test(message) ||
      /\bfailed to (?:spawn|launch|execute|start)\b/i.test(message) ||
      /\bcommand not found\b/i.test(message) ||
      /\bno such file or directory\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.INPUT_TOO_LARGE,
    errorReason: "input_too_large",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\binput (?:is )?too large\b/i.test(message) ||
      /\bexceeds? the maximum\b/i.test(message) ||
      /\b(?:context (?:length|window)|prompt)\b[^.]{0,40}\b(?:exceed|too long)/i.test(message) ||
      /\btoo many tokens\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.AUTH,
    errorReason: "auth_required",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\bunauthorized\b/i.test(message) ||
      /\bunauthenticated\b/i.test(message) ||
      /\bnot logged in\b/i.test(message) ||
      /\bplease (?:sign|log) in\b/i.test(message) ||
      /\bsession expired\b/i.test(message) ||
      /\b(?:api key|token)\b[^.]{0,20}\b(?:invalid|expired|missing)\b/i.test(message) ||
      /\bre-?authenticate\b/i.test(message) ||
      /\bauthentication failed\b/i.test(message) ||
      /\blogin required\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.MODEL_CONFIG,
    errorReason: "model_not_supported",
    retryDecision: TERMINAL,
    matches: (message) =>
      /\bmodel\b[^.]{0,40}\b(?:not supported|unsupported|not available|not found|does not exist)\b/i.test(
        message,
      ) || /\bunsupported\b[^.]{0,40}\bmodel\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.TIMEOUT,
    errorReason: "provider_timeout",
    retryDecision: TERMINAL,
    matches: (message) => /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_CONNECTION,
    errorReason: "provider_connection_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN)\b/.test(message) ||
      /\bconnection (?:reset|refused|closed|failed)\b/i.test(message) ||
      /\bunable to connect\b/i.test(message) ||
      /\bnetwork (?:error|unreachable)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_STREAM,
    errorReason: "provider_stream_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\bstream\b[^.]{0,20}\b(?:closed|ended|terminated)\b[^.]{0,20}\bunexpectedly\b/i.test(
        message,
      ) ||
      /\berror decoding\b.*\bresponse\b/i.test(message) ||
      /\bincomplete (?:response|stream)\b/i.test(message) ||
      /\bpremature (?:close|end)\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
    errorReason: "rate_limited",
    retryDecision: RETRY,
    matches: (message) =>
      /\brate.?limit(?:ed|ing)?\b/i.test(message) ||
      /\btoo many requests\b/i.test(message) ||
      /\bat capacity\b/i.test(message) ||
      /\b429\b/.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.PROVIDER_SERVER,
    errorReason: "provider_server_error",
    retryDecision: RETRY,
    matches: (message) =>
      /\b5\d{2}\b/.test(message) ||
      /\b(?:internal server|upstream|provider) error\b/i.test(message) ||
      /\bservice unavailable\b/i.test(message) ||
      /\bbad gateway\b/i.test(message),
  },
  {
    errorClass: RUNTIME_ERROR_CLASS.NOT_FOUND,
    errorReason: "not_found",
    retryDecision: RETRY,
    matches: (message) => /\bnot found\b/i.test(message),
  },
];

/** Classifies a runtime failure from its own text alone (no provider hint involved — see the
 * module comment for why callers that care about a provider's own hint apply it separately). */
export function classifyRuntimeErrorText(message: string): RuntimeErrorClassification {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.matches(message))
      return {
        errorClass: rule.errorClass,
        errorReason: rule.errorReason,
        retryDecision: rule.retryDecision,
      };
  }
  return {
    errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
    errorReason: "runtime_failure",
    retryDecision: RETRY,
  };
}
