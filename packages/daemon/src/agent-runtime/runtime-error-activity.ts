import type { AgentActivity, AgentRuntimeEvent } from "@coforge/agent";
import { AGENT_ACTIVITY_DETAIL_KIND, truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { classifyRuntimeErrorText } from "./runtime-error-classification";

/**
 * The single place a provider's error, crash or reconnect report becomes an Activity: a
 * provider's own message is shown as reported; the crash summary built at process exit is
 * redacted and capped at 512 characters; every runtime failure gets the same structured
 * classification and fingerprint.
 */

/** Matches the cap `daemon-runtime/runtime.ts`'s `safeRuntimeActivityMessage`
 * already applies to every other error-level Activity (spec: "Length limit"). */
const MAX_VISIBLE_ERROR_CHARS = 512;

/**
 * Redacts secrets that might appear in a raw provider error/crash message before
 * it becomes visible Activity text. CoForge's redaction here is intentionally
 * broader than a plain `Bearer <token>`/API-key regex: it also catches generic
 * `key=value`-shaped credential assignments (`token=...`, `password=...`), not
 * just recognized token prefixes. Reused by every provider's `error`/
 * `reconnecting` event, so there is exactly one redaction implementation for
 * runtime-failure text (the pre-existing `scrubActivityText` in runtime.ts,
 * which still applies the same rules to warning-level and other error-adjacent
 * Activity text, delegates to this function so the two never drift apart).
 *
 * The `key=value` pattern keeps its prefix via a real capturing group, matching
 * `redactTrajectoryText` in activity-trajectory.ts (`$1[REDACTED]`) — the
 * previous `runtime.ts` copy of this rule referenced a non-existent capture
 * group (`"$1=[REDACTED]"` with no parentheses around the prefix), which left
 * a literal `$1=` in the output instead of redacting the value; fixed here as
 * part of consolidating every runtime-failure scrubber into this one function.
 */
export function scrubRuntimeErrorText(message: string): string {
  const redacted = message
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return truncateCodePoints(redacted, MAX_VISIBLE_ERROR_CHARS);
}

/**
 * FNV-1a 32-bit hash rendered as 8 hex characters — the one fingerprint
 * algorithm shared by every runtime failure's `runtimeError.fingerprint`,
 * grouping repeats of what is, after redaction, the same failure text.
 * Previously duplicated between the Codex provider (its own `fingerprint()`)
 * and this module's daemon-core equivalent; the Codex provider now reuses this
 * implementation via its own richer `providerErrorCode`/`providerErrorClass`.
 */
export function fingerprintRuntimeError(message: string): string {
  let hash = 2166136261;
  for (const character of message) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type RuntimeErrorEvent = Extract<AgentRuntimeEvent, { type: "error" }>;
export type RuntimeReconnectingEvent = Extract<AgentRuntimeEvent, { type: "reconnecting" }>;

/**
 * Builds the visible Activity for a provider-reported `error` event observed
 * mid-turn. Always attaches a single `{ kind: "text", text: "Error: ..." }`
 * trajectory entry (spec §7) alongside the top-level `detail`, so the message
 * is visible both in the current-status line and in the popover/history entry.
 */
export function buildRuntimeErrorActivity(event: RuntimeErrorEvent): AgentActivity {
  // A provider's own error message is shown as reported; only the crash summary built at
  // process exit is redacted and capped.
  const detail = event.message;
  // A provider's own richer class/reason hint is always kept as-is; only text this daemon has no
  // provider hint for gets classified here (runtime-error-classification.ts) instead of the
  // previous generic "AgentRuntimeError"/"runtime_failure" default for every unhinted message.
  const classified = classifyRuntimeErrorText(detail);
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
    level: "error",
    detail,
    observedAtMs: event.occurredAt ? Date.parse(event.occurredAt) : Date.now(),
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: {
      errorClass: event.providerErrorClass ?? event.providerErrorCode ?? classified.errorClass,
      errorReason: event.providerErrorReason ?? classified.errorReason,
      fingerprint: fingerprintRuntimeError(detail),
    },
  };
}

/**
 * Builds the visible Activity for a process exit that leaves an `error` event
 * unresolved (no `completed` observed after it) — a real crash, not a clean
 * idle exit. `lastError` is the most recent unresolved `error` event's already-
 * tracked facts (daemon-runtime/runtime.ts clears it on `completed`); the exit
 * itself carries no OS-level exit code/signal (`AgentSession.onExit` takes no
 * arguments in this codebase), so "Crashed" wording can only describe the last
 * observed error, never a signal/exit-code summary the way the behavioural
 * reference does — see the report for that difference.
 */
export function buildRuntimeCrashedActivity(lastError: RuntimeErrorEvent): AgentActivity {
  const detail = `Crashed (${scrubRuntimeErrorText(lastError.message)})`;
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
    level: "error",
    detail,
    observedAtMs: Date.now(),
    entries: [{ kind: "text", text: `Error: ${detail}` }],
    runtimeError: {
      // The exit reason itself is always "runtime_crashed" below, regardless of the underlying
      // error's own class; only the class is worth refining from an unhinted provider message.
      errorClass:
        lastError.providerErrorClass ??
        lastError.providerErrorCode ??
        classifyRuntimeErrorText(lastError.message).errorClass,
      errorReason: "runtime_crashed",
      fingerprint: fingerprintRuntimeError(detail),
    },
  };
}

/** Builds the visible Activity for a provider reconnecting to its upstream. */
export function buildRuntimeReconnectingActivity(event: RuntimeReconnectingEvent): AgentActivity {
  const detail = event.message || "Reconnecting to provider…";
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING,
    level: "info",
    detail,
    observedAtMs: Date.now(),
    entries: [{ kind: "text", text: detail }],
  };
}
