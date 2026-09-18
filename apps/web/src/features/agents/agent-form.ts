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
