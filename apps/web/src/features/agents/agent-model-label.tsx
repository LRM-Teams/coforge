import { ClientOnly } from "@tanstack/react-router";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useAgentModelName } from "#src/features/settings/agent-model-name";
import { useAgentModel } from "./agent-models";

/** An Agent's configured model beside its name in chat (Settings → Show agent model). Draws
 * nothing while the setting is off, before the models load, or for an Agent on its runtime's
 * default model. The full id is in the tooltip when a long one is cut. */
export function AgentModelLabel({ agentId }: { agentId: string }) {
  return (
    <ClientOnly>
      <AgentModelLabelContent agentId={agentId} />
    </ClientOnly>
  );
}

/**
 * The label's body, inside a `ClientOnly` boundary. The model comes from a React Query read and
 * the visibility from a device preference, so a server render has neither: outside the client the
 * row must render exactly as it did before this label existed — which is also what the message
 * row's static-render tests check.
 */
function AgentModelLabelContent({ agentId }: { agentId: string }) {
  const [show] = useAgentModelName();
  const model = useAgentModel(agentId, show);
  if (!show || !model) return null;
  return (
    <Tooltip title={model}>
      <span className="max-w-48 min-w-0 shrink truncate text-xs text-tertiary">{model}</span>
    </Tooltip>
  );
}
