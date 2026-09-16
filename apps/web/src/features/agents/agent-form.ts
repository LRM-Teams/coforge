import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import type { UpdateAgentInput } from "./agent.schemas";

export function updateAgentInputFromForm(
  form: FormData,
  fallback: { agentId: string; computerId?: string },
): UpdateAgentInput {
  const computerId = String(form.get("computerId") ?? fallback.computerId ?? "").trim();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  return {
    agentId: fallback.agentId,
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    provider: parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE,
    modelProvider: String(form.get("modelProvider") ?? ""),
    model: String(form.get("model") ?? ""),
    reasoning: String(form.get("reasoning") ?? ""),
    ...(apiKey ? { apiKey } : {}),
    ...(computerId ? { computerId } : {}),
  };
}
