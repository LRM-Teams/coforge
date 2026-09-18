import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
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

/**
 * The Agent-update failure copy shared by the full-page edit dialog and the Profile panel's
 * in-place runtime editor — the same `updateAgent` `errorId`s, mapped to the same sentences,
 * so the two surfaces never drift.
 */
export function agentUpdateErrorMessage(cause: unknown): string {
  if (isAppError(cause) && cause.errorId === "agent-api-key-required")
    return m.agent_form_api_key_required();
  if (isAppError(cause) && cause.errorId === "agent-runtime-unavailable")
    return m.agent_form_runtime_unavailable();
  if (isAppError(cause) && cause.errorId === "agent-computer-required")
    return m.agent_form_computer_required();
  return m.agent_update_error();
}

/**
 * The Runtime config dialog's Advanced env rows are plain `[name="envKey"]`/`[name="envValue"]`
 * inputs (`agent-runtime-config-dialog.tsx`), read back here as parallel `FormData.getAll()`
 * arrays. Empty keys are dropped; the last duplicate key wins (ADR 0045). No name-format validation here — the
 * server (`agent-environment.server.ts`'s `validateAgentEnvironment`) is the single source of
 * truth for what a valid variable name is.
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
