import {
  AGENT_ENVIRONMENT_MAX_NAME_LENGTH,
  AGENT_ENVIRONMENT_MAX_VARIABLES,
  agentEnvironmentNameViolation,
  type AgentEnvironmentViolation,
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";

import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { UpdateAgentInput } from "./agent.schemas";

/**
 * Builds `UpdateAgentInput` from a runtime-edit form. `displayName`/`description` are only
 * read from the form when it actually carries those fields (the full-page edit dialog does);
 * a caller whose form omits them — the Profile panel's runtime-only form — supplies the
 * current value through `fallback` so the Agent's name/description are never blanked.
 */
export function updateAgentInputFromForm(
  form: FormData,
  fallback: { agentId: string; computerId?: string; displayName?: string; description?: string },
): UpdateAgentInput {
  const computerId = String(form.get("computerId") ?? fallback.computerId ?? "").trim();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  const displayName = String(form.get("displayName") ?? fallback.displayName ?? "").trim();
  const description = form.has("description")
    ? String(form.get("description") ?? "")
    : (fallback.description ?? "");
  return {
    agentId: fallback.agentId,
    description,
    provider: parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE,
    modelProvider: String(form.get("modelProvider") ?? ""),
    model: String(form.get("model") ?? ""),
    reasoning: String(form.get("reasoning") ?? ""),
    ...(apiKey ? { apiKey } : {}),
    ...(displayName ? { displayName } : {}),
    ...(computerId ? { computerId } : {}),
  };
}

/** The copy for each rule an Agent environment can break; a `Record` so a new rule cannot ship without it. */
const AGENT_ENVIRONMENT_ERROR_MESSAGES: Record<AgentEnvironmentViolation, () => string> = {
  "too-many": () => m.agent_env_too_many({ max: AGENT_ENVIRONMENT_MAX_VARIABLES }),
  "invalid-name": () => m.agent_env_invalid_name({ max: AGENT_ENVIRONMENT_MAX_NAME_LENGTH }),
  "reserved-name": m.agent_env_reserved_name,
  "invalid-value": m.agent_env_invalid_value,
  "too-large": m.agent_env_too_large,
};

/**
 * The copy for each `errorId` an Agent create or update can fail with, shared by the create
 * dialog, the full-page edit dialog and the Profile panel's in-place runtime editor so the
 * surfaces never drift.
 */
const AGENT_FORM_ERROR_MESSAGES = new Map<string, () => string>([
  ["agent-api-key-required", m.agent_form_api_key_required],
  ["agent-runtime-unavailable", m.agent_form_runtime_unavailable],
  ["agent-computer-required", m.agent_form_computer_required],
  ["agent-name-taken", m.agent_form_name_taken],
  ...Object.entries(AGENT_ENVIRONMENT_ERROR_MESSAGES).map(
    ([violation, message]) => [`agent-environment-${violation}`, message] as const,
  ),
]);

function agentFormErrorMessage(cause: unknown, fallback: () => string): string {
  const message = isAppError(cause)
    ? AGENT_FORM_ERROR_MESSAGES.get(cause.errorId ?? "")
    : undefined;
  return (message ?? fallback)();
}

export function agentUpdateErrorMessage(cause: unknown): string {
  return agentFormErrorMessage(cause, m.agent_update_error);
}

export function agentCreateErrorMessage(cause: unknown): string {
  return agentFormErrorMessage(cause, m.agent_form_server_error);
}

/**
 * The inline error for one env row's name, from the same SDK rule the server applies. A blank name
 * is not an error: that row is dropped on save.
 */
export function agentEnvironmentNameError(key: string): string | undefined {
  const name = key.trim();
  const violation = name ? agentEnvironmentNameViolation(name) : undefined;
  return violation && AGENT_ENVIRONMENT_ERROR_MESSAGES[violation]();
}

/**
 * The Runtime config dialog's Advanced env rows are plain `[name="envKey"]`/`[name="envValue"]`
 * inputs (`agent-runtime-config-dialog.tsx`), read back here as parallel `FormData.getAll()`
 * arrays. Empty keys are dropped; the last duplicate key wins. The dialog flags bad names per row
 * (`agentEnvironmentNameError`); the server's `validateAgentEnvironment` enforces the whole rule.
 */
export function parseAgentEnvironmentFromForm(form: FormData): Record<string, string> {
  const keys = form.getAll("envKey").map(String);
  const values = form.getAll("envValue").map(String);
  const result: Record<string, string> = {};
  keys.forEach((key, index) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    result[trimmed] = values[index] ?? "";
  });
  return result;
}

/** Order-insensitive comparison the Advanced disclosure uses to decide its own dirty state, and
 * the panel reuses to know whether a save should call `saveAgentEnvironment` at all. */
export function agentEnvironmentRowsChanged(
  rows: { key: string; value: string }[],
  initial: Record<string, string>,
): boolean {
  const next: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    next[key] = row.value;
  }
  const nextKeys = Object.keys(next);
  const initialKeys = Object.keys(initial);
  if (nextKeys.length !== initialKeys.length) return true;
  return nextKeys.some((key) => next[key] !== initial[key]);
}
